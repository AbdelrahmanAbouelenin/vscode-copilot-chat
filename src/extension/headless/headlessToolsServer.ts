/*---------------------------------------------------------------------------------------------
 *  Headless tools server
 *
 *  Exposes Copilot Chat tools via HTTP API for headless/container environments.
 *  All tool requests are routed through the VS Code Copilot Chat extension.
 *
 *  Tool invocation strategy:
 *    - Copilot tools (file ops, search, etc.): Call tool.invoke() directly via IToolsService
 *    - VS Code core tools (run_in_terminal, etc.): Use vscode.lm.invokeTool() with undefined token
 *    - Terminal tools in headless: Use HeadlessPseudoterminal for shell execution
 *
 *  API endpoints:
 *    GET  /              - Health check and list available tools
 *    GET  /tools         - List tools with schemas
 *    POST /invoke        - Invoke a single tool: { tool: string, args: object, confirm?: boolean }
 *    POST /batch         - Invoke multiple tools: { tool_calls: [...], confirm?: boolean }
 *    POST /tools/:name   - Shorthand for single tool invocation
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';
import { CancellationTokenSource } from '../../util/vs/base/common/cancellation';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../common/contributions';
import { IToolsService } from '../tools/common/toolsService';
import { LanguageModelTextPart, LanguageModelPromptTsxPart, LanguageModelDataPart, LanguageModelPartAudience, TextEdit } from '../../vscodeTypes';
import { renderDataPartToString, renderToolResultToStringNoBudget } from '../prompt/vscode-node/requestLoggerToolResult';
import { getContributedToolName } from '../tools/common/toolNames';

import {
	ToolResult, ToolContext, ManagedTerminal, TrackedOpenFile,
	InvokeRequest, BatchRequest, ContextRequest, SystemPromptRequest
} from './types';
import {
	PORT, MODEL_CONTEXT_LENGTH, MAX_TOOL_RESPONSE_PCT,
	MAX_TOOL_RESULT_TOKENS, APPROX_CHARS_PER_TOKEN
} from './constants';
import { truncateToolResult, formatError } from './utils';
import { HeadlessPseudoterminal } from './pseudoterminal';
import { createMockStream } from './mockEditStream';
import { buildContext, buildSystemPrompt } from './promptBuilder';
import { isHeadlessOnlyTool, invokeHeadlessOnlyTool, invokeFallbackTool, getHeadlessToolSchemas } from './tools';

/**
 * Headless tools server.
 * Invokes Copilot tools directly via their invoke() method, bypassing vscode.lm.invokeTool()
 * to avoid authentication requirements in headless mode.
 *
 * Terminal architecture:
 *   - Copilot terminal: Dedicated terminal for run_in_terminal tool (like VS Code's Copilot Terminal)
 *   - User terminals: Simulated user terminals created with create_terminal
 *   - terminal_last_command etc. read from USER's active terminal, not Copilot's
 */
export class HeadlessToolsServer extends Disposable implements IExtensionContribution {
	private server: http.Server | undefined;

	// Copilot's dedicated terminal (for run_in_terminal tool)
	private copilotTerminal: ManagedTerminal | undefined;

	// User terminal management (simulates user-created terminals)
	private userTerminals: Map<string, ManagedTerminal> = new Map();
	private activeUserTerminalId: string | undefined;
	private nextTerminalId = 1;

	// Open file management (tracks open files and their selections)
	private trackedOpenFiles: Map<string, TrackedOpenFile> = new Map();
	private activeFileUri: string | undefined;

	/** Per-file write queue to serialize edits to the same file */
	private readonly fileWriteQueue = new Map<string, Promise<void>>();

	/**
	 * Global invocation mutex to serialize tool invocations.
	 * Prevents concurrent /invoke requests from reading stale file content
	 * and applying edits based on outdated ranges.
	 */
	private invocationMutex: Promise<void> = Promise.resolve();

	constructor(
		@IToolsService private readonly toolsService: IToolsService,
	) {
		super();

		if (process.env.COPILOT_TOOLS_API !== 'true') {
			return;
		}

		console.log('[HeadlessTools] Initializing...');
		this.ensureWorkspaceOpen();
		this.createCopilotTerminal();
		this.startServer();
	}

	/**
	 * Create Copilot's dedicated terminal (for run_in_terminal tool)
	 */
	private createCopilotTerminal(): void {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/workspace';
		const pty = new HeadlessPseudoterminal(cwd);
		const terminal = vscode.window.createTerminal({
			name: 'Copilot Terminal',
			pty: pty,
		});

		this.copilotTerminal = {
			id: 'copilot',
			name: 'Copilot Terminal',
			terminal,
			pty
		};

		this._register({ dispose: () => terminal.dispose() });
		console.log('[HeadlessTools] Created Copilot terminal');
	}

	/**
	 * Queue a file write operation. Writes to the same file are serialized.
	 */
	private queueFileWrite(uri: vscode.Uri, work: () => Promise<void>): Promise<void> {
		const key = uri.toString();
		const prev = this.fileWriteQueue.get(key) ?? Promise.resolve();

		const next = prev
			.catch(() => {})  // Don't let previous failures block the queue
			.then(work)
			.finally(() => {
				// Clean up if this is still the last queued operation
				if (this.fileWriteQueue.get(key) === next) {
					this.fileWriteQueue.delete(key);
				}
			});

		this.fileWriteQueue.set(key, next);
		return next;
	}

	/**
	 * Create a new user terminal (simulates user creating a terminal)
	 */
	private createUserTerminal(name?: string): ManagedTerminal {
		const id = `terminal_${this.nextTerminalId++}`;
		const terminalName = name || `Terminal ${this.nextTerminalId - 1}`;
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/workspace';

		const pty = new HeadlessPseudoterminal(cwd);
		const terminal = vscode.window.createTerminal({
			name: terminalName,
			pty: pty,
		});

		const managed: ManagedTerminal = { id, name: terminalName, terminal, pty };
		this.userTerminals.set(id, managed);

		// Make it the active user terminal
		this.activeUserTerminalId = id;

		// Register for cleanup
		this._register({ dispose: () => terminal.dispose() });

		console.log(`[HeadlessTools] Created user terminal: ${terminalName} (${id})`);
		return managed;
	}

	/**
	 * Get the active user terminal (for terminal_last_command, etc.)
	 */
	private getActiveUserTerminal(): ManagedTerminal | undefined {
		if (this.activeUserTerminalId) {
			return this.userTerminals.get(this.activeUserTerminalId);
		}
		return undefined;
	}

	/**
	 * Get user terminal by ID
	 */
	private getUserTerminal(id: string): ManagedTerminal | undefined {
		return this.userTerminals.get(id);
	}

	/**
	 * Delete a user terminal
	 */
	private deleteUserTerminal(id: string): boolean {
		return this.userTerminals.delete(id);
	}

	/**
	 * List all user terminals
	 */
	private listUserTerminals(): { id: string; name: string; isActive: boolean }[] {
		return Array.from(this.userTerminals.values()).map(t => ({
			id: t.id,
			name: t.name,
			isActive: t.id === this.activeUserTerminalId,
		}));
	}

	/**
	 * Ensure /workspace is open as a workspace folder
	 */
	private ensureWorkspaceOpen(): void {
		const workspacePath = '/workspace';
		const workspaceUri = vscode.Uri.file(workspacePath);
		const folders = vscode.workspace.workspaceFolders || [];

		if (folders.some(f => f.uri.fsPath === workspacePath)) {
			console.log(`[HeadlessTools] Workspace already open: ${workspacePath}`);
			return;
		}

		console.log(`[HeadlessTools] Adding workspace folder: ${workspacePath}`);
		vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: workspaceUri, name: 'workspace' });
	}

	/**
	 * Resolve a file path to a URI (handles relative and absolute paths)
	 */
	private resolveFilePath(path: string): vscode.Uri {
		// If it's an absolute path, use it directly
		if (path.startsWith('/')) {
			return vscode.Uri.file(path);
		}

		// Otherwise, resolve relative to workspace
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (workspaceFolder) {
			return vscode.Uri.joinPath(workspaceFolder.uri, path);
		}

		// Fallback: treat as relative to /workspace
		return vscode.Uri.file(`/workspace/${path}`);
	}

	/**
	 * Get the tool context for tool handlers
	 */
	private getToolContext(): ToolContext {
		return {
			copilotTerminal: this.copilotTerminal,
			userTerminals: this.userTerminals,
			activeUserTerminalId: this.activeUserTerminalId,
			trackedOpenFiles: this.trackedOpenFiles,
			activeFileUri: this.activeFileUri,
			queueFileWrite: (uri, work) => this.queueFileWrite(uri, work),
			resolveFilePath: (path) => this.resolveFilePath(path),
			setActiveUserTerminalId: (id) => { this.activeUserTerminalId = id; },
			setActiveFileUri: (uri) => { this.activeFileUri = uri; },
			createUserTerminal: (name) => this.createUserTerminal(name),
			getUserTerminal: (id) => this.getUserTerminal(id),
			getActiveUserTerminal: () => this.getActiveUserTerminal(),
			deleteUserTerminal: (id) => this.deleteUserTerminal(id),
		};
	}

	/**
	 * Start the HTTP server
	 */
	private startServer(): void {
		this.server = http.createServer(async (req, res) => {
			// CORS headers
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}

			try {
				await this.handleRequest(req, res);
			} catch (err: any) {
				this.sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
			}
		});

		this.server.listen(PORT, '0.0.0.0', () => {
			console.log(`[HeadlessTools] Server running on port ${PORT}`);
		});

		this.server.on('error', (err: any) => {
			if (err.code === 'EADDRINUSE') {
				console.log(`[HeadlessTools] Port ${PORT} already in use`);
			} else {
				console.error('[HeadlessTools] Server error:', err);
			}
		});

		this._register({ dispose: () => this.server?.close() });
	}

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url || '/', `http://localhost:${PORT}`);

		// Health check / list tools
		if (url.pathname === '/' || url.pathname === '/health') {
			const tools = this.toolsService.tools;
			const rawVscodeTools = [...vscode.lm.tools].map(t => t.name);
			this.sendJson(res, 200, {
				status: 'ok',
				toolCount: tools.length,
				tools: tools.map(t => t.name),
				rawVscodeTools,
				copilotTerminal: this.copilotTerminal ? { id: 'copilot', name: 'Copilot Terminal' } : null,
				userTerminals: this.listUserTerminals(),
				activeUserTerminal: this.activeUserTerminalId,
				// Truncation configuration (matches VS Code's agentPrompt.tsx calculation)
				truncation: {
					modelContextLength: MODEL_CONTEXT_LENGTH,
					maxToolResponsePct: MAX_TOOL_RESPONSE_PCT,
					maxToolResultTokens: MAX_TOOL_RESULT_TOKENS,
					approxCharsPerToken: APPROX_CHARS_PER_TOKEN,
				}
			});
			return;
		}

		// List terminals (quick endpoint)
		if (url.pathname === '/terminals' && req.method === 'GET') {
			this.sendJson(res, 200, {
				copilotTerminal: this.copilotTerminal ? {
					id: 'copilot',
					name: 'Copilot Terminal',
					lastCommand: this.copilotTerminal.pty.getLastCommand()?.command || null
				} : null,
				userTerminals: this.listUserTerminals(),
				activeUserTerminal: this.activeUserTerminalId
			});
			return;
		}

		// List tools with details
		if (url.pathname === '/tools' && req.method === 'GET') {
			const tools = this.toolsService.tools.map(t => {
				let schema = t.inputSchema || {};

				// Fix manage_todo_list schema to match original:
				// - Remove 'operation' (internal-only, not exposed to model)
				// - Ensure 'todoList' is required
				if (t.name === 'manage_todo_list') {
					const properties = schema.properties ? { ...schema.properties } : {};
					delete properties.operation;
					let required = (schema.required || []).filter((r: string) => r !== 'operation');
					if (!required.includes('todoList')) {
						required = [...required, 'todoList'];
					}
					schema = { ...schema, properties, required };
				}

				return {
					name: t.name,
					description: t.description || '',
					inputSchema: schema
				};
			});

			// Add custom headless tool schemas
			const headlessSchemas = getHeadlessToolSchemas();

			this.sendJson(res, 200, { tools: [...tools, ...headlessSchemas] });
			return;
		}

		// Context endpoint - builds the per-request user message context
		if (url.pathname === '/context' && req.method === 'POST') {
			const body = await this.parseBody(req) as ContextRequest;
			const context = this.getToolContext();
			const result = await buildContext(
				body,
				context,
				(name, args, confirm) => this.invokeTool(name, args, confirm)
			);
			this.sendJson(res, result.success ? 200 : 400, result);
			return;
		}

		// System prompt endpoint - builds the system prompt (mirrors DefaultAgentPrompt)
		if (url.pathname === '/system-prompt' && req.method === 'POST') {
			const body = await this.parseBody(req) as SystemPromptRequest;
			const result = await buildSystemPrompt(body, this.toolsService);
			this.sendJson(res, result.success ? 200 : 400, result);
			return;
		}

		// Invoke single tool
		if (url.pathname === '/invoke' && req.method === 'POST') {
			const body = await this.parseBody(req) as InvokeRequest;
			const result = await this.invokeTool(body.tool, body.args, body.confirm ?? false);
			this.sendJson(res, result.success ? 200 : 400, result);
			return;
		}

		// Batch invoke
		if (url.pathname === '/batch' && req.method === 'POST') {
			const body = await this.parseBody(req) as BatchRequest;
			const results = await this.invokeBatch(body);
			this.sendJson(res, 200, { tool_outputs: results });
			return;
		}

		// Shorthand: POST /tools/:name
		const toolMatch = url.pathname.match(/^\/tools\/([^/]+)$/);
		if (toolMatch && req.method === 'POST') {
			const body = await this.parseBody(req);
			const confirm = body.confirm ?? false;
			delete body.confirm;
			const result = await this.invokeTool(toolMatch[1], body, confirm);
			this.sendJson(res, result.success ? 200 : 400, result);
			return;
		}

		this.sendJson(res, 404, { error: 'Not found' });
	}

	/**
	 * Invoke multiple tools sequentially to prevent race conditions on file edits.
	 * Parallel execution was causing issues where both tools read old content,
	 * both write, and one overwrites the other.
	 */
	private async invokeBatch(request: BatchRequest): Promise<ToolResult[]> {
		const batchConfirm = request.confirm ?? false;
		const results: ToolResult[] = [];

		for (let i = 0; i < (request.tool_calls || []).length; i++) {
			const call = request.tool_calls[i];
			const confirm = call.confirm ?? batchConfirm;
			const result = await this.invokeTool(call.name, call.args, confirm);
			results.push({
				tool_call_id: call.id || `call_${i}`,
				...result
			});
		}

		return results;
	}

	/**
	 * Invoke a single tool.
	 * Uses direct invoke() for Copilot tools, falls back to shell execution for terminal commands.
	 *
	 * Serialized via invocationMutex to prevent concurrent invocations from causing
	 * stale-range edits (where two tools read the same file, compute edits based on
	 * that content, then one overwrites the other's changes).
	 */
	private async invokeTool(toolName: string, args: Record<string, unknown>, confirm: boolean): Promise<ToolResult> {
		// Acquire the global invocation mutex - serialize all tool invocations
		// to prevent concurrent reads leading to stale-range edits
		let releaseMutex: () => void;
		const mutexPromise = new Promise<void>(resolve => { releaseMutex = resolve; });
		const previousMutex = this.invocationMutex;
		this.invocationMutex = mutexPromise;

		try {
			// Wait for previous invocation to complete
			await previousMutex;
			return await this.invokeToolInternal(toolName, args, confirm);
		} finally {
			releaseMutex!();
		}
	}

	/**
	 * Internal tool invocation logic (called after acquiring mutex).
	 */
	private async invokeToolInternal(toolName: string, args: Record<string, unknown>, confirm: boolean): Promise<ToolResult> {
		console.log(`[HeadlessTools] Invoking tool: ${toolName}${confirm ? ' (confirm=true)' : ''}`);

		const context = this.getToolContext();

		// Handle custom headless-only tools first (not in toolsService or need special handling)
		if (isHeadlessOnlyTool(toolName)) {
			const result = await invokeHeadlessOnlyTool(toolName, args, context, confirm);
			if (result) return result;
		}

		// Check if tool exists in toolsService
		const toolInfo = this.toolsService.tools.find(t => t.name === toolName);
		if (!toolInfo) {
			const available = this.toolsService.tools.map(t => t.name).join(', ');
			return { success: false, error: `Tool not found: ${toolName}. Available: ${available}` };
		}

		// Create cancellation token
		const cts = new CancellationTokenSource();

		try {
			// Try to get the Copilot tool implementation directly
			const tool = this.toolsService.getCopilotTool(toolName);

			if (tool?.invoke) {
				// Check if tool requires confirmation
				if (tool.prepareInvocation && !confirm) {
					try {
						const prepared = await tool.prepareInvocation({ input: args }, cts.token);
						if (prepared && 'confirmationMessages' in prepared && prepared.confirmationMessages) {
							const title = prepared.confirmationMessages.title || 'Confirmation required';
							const message = typeof prepared.confirmationMessages.message === 'string'
								? prepared.confirmationMessages.message
								: prepared.confirmationMessages.message?.value || 'This action requires confirmation';
							return {
								success: false,
								error: `Confirmation required: ${title}. ${message}. Pass "confirm": true to approve.`
							};
						}
					} catch (prepareErr) {
						console.log(`[HeadlessTools] prepareInvocation check failed for ${toolName}:`, prepareErr);
					}
				}

				// Create mock stream for file edit capture
				const pendingEdits = new Map<string, { edits: TextEdit[]; uri: vscode.Uri }>();
				const pendingWrites: Promise<void>[] = [];

				const mockStream = createMockStream(
					(uri, work) => this.queueFileWrite(uri, work),
					pendingEdits,
					pendingWrites
				);

				// Call resolveInput if available
				if (tool.resolveInput) {
					try {
						const mockPromptContext = {
							stream: mockStream,
							request: { model: undefined },
							tools: { toolReferences: [], availableTools: [] },
						} as any;
						await tool.resolveInput(args, mockPromptContext, 0 as any);
					} catch (resolveErr: any) {
						console.log(`[HeadlessTools] resolveInput failed for ${toolName}:`, resolveErr.message);
					}
				}

				// Direct invoke
				console.log(`[HeadlessTools] Using direct invoke for: ${toolName}`);
				const invocationToken = confirm ? { headlessConfirm: true } as any : undefined;
				const result = await tool.invoke({
					input: args,
					toolInvocationToken: invocationToken,
				}, cts.token);

				// Close the stream to flush any remaining pending edits
				// This handles the case where the tool returns without calling textEdit(uri, true)
				mockStream.close();

				// Drain all pending file writes until none remain
				// We loop because new writes can be pushed while we're awaiting
				try {
					let drainCount = 0;
					while (pendingWrites.length > 0) {
						const currentBatch = pendingWrites.splice(0, pendingWrites.length); // Take all current promises
						console.log(`[HeadlessTools] Draining ${currentBatch.length} file write(s) (round ${++drainCount})...`);
						await Promise.all(currentBatch);
					}
				} catch (writeErr: any) {
					return {
						success: false,
						error: `File write failed: ${writeErr.message}`
					};
				}

				if (!result) {
					return { success: false, error: 'Tool returned no result' };
				}

				return {
					success: true,
					result: await this.extractResult(result)
				};
			} else {
				// No direct invoke available - handle VS Code core tools

				// Try fallback headless handlers for terminal and other tools
				const fallbackResult = await invokeFallbackTool(toolName, args, context, confirm);
				if (fallbackResult) return fallbackResult;

				// For other VS Code core tools, try vscode.lm.invokeTool
				console.log(`[HeadlessTools] Using vscode.lm.invokeTool for: ${toolName}`);
				const contributedName = getContributedToolName(toolName);

				// For manage_todo_list: inject 'operation: write' if not specified
				// (model schema doesn't expose operation, but VSCode's implementation needs it)
				let toolArgs = args;
				if (toolName === 'manage_todo_list' && !args.operation && args.todoList) {
					toolArgs = { ...args, operation: 'write' };
				}

				try {
					const result = await vscode.lm.invokeTool(contributedName, {
						toolInvocationToken: undefined,
						input: toolArgs,
					}, cts.token);

					return {
						success: true,
						result: await this.extractResult(result)
					};
				} catch (invokeErr: any) {
					console.error(`[HeadlessTools] vscode.lm.invokeTool failed for ${toolName}:`, invokeErr.message);
					return {
						success: false,
						error: invokeErr.message || String(invokeErr)
					};
				}
			}
		} catch (err: any) {
			console.error(`[HeadlessTools] Tool ${toolName} failed:`, err.message);
			return {
				success: false,
				error: err.message || String(err)
			};
		}
	}

	/**
	 * Extract text content from LanguageModelToolResult.
	 * Matches the behavior of PrimitiveToolResult.render() in toolCalling.tsx:
	 * - Filters parts by assistant audience
	 * - Handles text, TSX, and data parts
	 * - Returns '(empty)' for empty results (matches <IfEmpty alt='(empty)'>)
	 * - Applies truncation following the same format as ToolResult.onText()
	 *
	 * @param result The tool result to extract
	 * @param maxTokens Maximum tokens for the result (default: MAX_TOOL_RESULT_TOKENS, calculated from model context)
	 * @returns Extracted and truncated text content
	 */
	private async extractResult(result: vscode.LanguageModelToolResult, maxTokens: number = MAX_TOOL_RESULT_TOKENS): Promise<string> {
		if (!result) {
			return '(empty)';
		}

		if (!('content' in result) || !result.content) {
			return String(result) || '(empty)';
		}

		const parts: string[] = [];

		for (const part of result.content) {
			if (!part) continue;

			try {
				// Filter by audience (matches hasAssistantAudience in PrimitiveToolResult from toolCalling.tsx)
				// Logic: TSX parts always included, parts without audience included, otherwise check for Assistant
				if (!this.hasAssistantAudience(part)) {
					continue;
				}

				if (part instanceof LanguageModelTextPart) {
					parts.push(part.value);
				} else if (part instanceof LanguageModelPromptTsxPart) {
					const rendered = await renderToolResultToStringNoBudget(part);
					parts.push(rendered);
				} else if (part instanceof LanguageModelDataPart) {
					parts.push(renderDataPartToString(part));
				} else if (typeof part === 'object' && 'value' in part) {
					parts.push(String((part as any).value));
				}
			} catch (err) {
				console.error('[HeadlessTools] Error extracting result:', err);
			}
		}

		const fullResult = parts.join('');

		// Match <IfEmpty alt='(empty)'> behavior from PrimitiveToolResult
		if (!fullResult || fullResult.trim() === '') {
			return '(empty)';
		}

		// Apply truncation following the same format as the extension
		return truncateToolResult(fullResult, maxTokens);
	}

	private parseBody(req: http.IncomingMessage): Promise<any> {
		return new Promise((resolve, reject) => {
			let body = '';
			req.on('data', (chunk: Buffer) => body += chunk.toString());
			req.on('end', () => {
				try {
					resolve(body ? JSON.parse(body) : {});
				} catch {
					reject(new Error('Invalid JSON body'));
				}
			});
			req.on('error', reject);
		});
	}

	private sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
		res.writeHead(statusCode, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(data, null, 2));
	}

	/**
	 * Check if a tool result part should be included for the assistant.
	 * Matches the exact logic from hasAssistantAudience() in toolCalling.tsx:
	 * - TSX parts: always included (return true)
	 * - Parts without audience property: included (return true)
	 * - Parts with audience: check if LanguageModelPartAudience.Assistant is in the array
	 */
	private hasAssistantAudience(part: unknown): boolean {
		// TSX parts are always included
		if (part instanceof LanguageModelPromptTsxPart) {
			return true;
		}

		// Check if part has an audience property
		if (part && typeof part === 'object' && 'audience' in part) {
			const audience = (part as any).audience;
			// If no audience specified, include by default
			if (!audience || !Array.isArray(audience)) {
				return true;
			}
			// Check if Assistant (enum value 0) is in the audience array
			return audience.includes(LanguageModelPartAudience.Assistant);
		}

		// Default: include parts without audience
		return true;
	}
}
