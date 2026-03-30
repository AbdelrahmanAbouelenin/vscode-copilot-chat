/*---------------------------------------------------------------------------------------------
 *  Type definitions for headless tools server
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Tracks executed commands for headless terminal
 */
export interface ExecutedCommand {
	command: string;
	output: string;
	cwd: string;
	exitCode: number | undefined;
	timestamp: number;
}

/**
 * Represents a managed terminal in headless mode
 */
export interface ManagedTerminal {
	id: string;
	name: string;
	terminal: vscode.Terminal;
	pty: IHeadlessPseudoterminal;
	selectedLineRange?: { start: number; end: number };
}

/**
 * Interface for headless pseudoterminal (allows dependency injection)
 */
export interface IHeadlessPseudoterminal extends vscode.Pseudoterminal {
	executeCommand(command: string, timeoutMs?: number): Promise<string>;
	getLastCommand(): ExecutedCommand | undefined;
	getCommandHistory(): ExecutedCommand[];
	getOutputBuffer(maxChars?: number): string;
	setCwd(cwd: string): void;
	getCwd(): string;
}

/**
 * Represents an open file being tracked
 */
export interface TrackedOpenFile {
	uri: vscode.Uri;
	selectedLineRange?: { start: number; end: number };
}

/**
 * Tool call input for batch requests
 */
export interface ToolCallInput {
	id?: string;
	name: string;
	args: Record<string, unknown>;
	confirm?: boolean;
}

/**
 * Single tool invocation request
 */
export interface InvokeRequest {
	tool: string;
	args: Record<string, unknown>;
	confirm?: boolean;
}

/**
 * Batch tool invocation request
 */
export interface BatchRequest {
	tool_calls: ToolCallInput[];
	confirm?: boolean;
}

/**
 * Tool invocation result
 */
export interface ToolResult {
	tool_call_id?: string;
	success: boolean;
	result?: unknown;
	msg?: string;
	error?: string;
}

/**
 * Request for /context endpoint - builds the per-request user message context
 */
export interface ContextRequest {
	/** The user's query/prompt */
	query: string;
	/** Files to attach as context */
	attachedFiles?: Array<{
		path: string;
		startLine?: number;
		endLine?: number;
	}>;
	/** Terminal ID to include state from (uses active terminal if not specified) */
	terminalId?: string;
	/** Include todo list in context */
	includeTodoList?: boolean;
}

/**
 * Request for /system-prompt endpoint - builds the system prompt
 */
export interface SystemPromptRequest {
	/** Model name for identity rules (e.g., "Claude 3.5 Sonnet") */
	modelName?: string;
	/** Available tools - if not provided, uses all registered tools */
	availableTools?: string[];
	/** Whether to include workspace structure in global context (default: true) */
	includeWorkspaceStructure?: boolean;
	/** Max lines for workspace structure (default: 100) */
	workspaceStructureMaxLines?: number;
	/** Custom instructions to include (e.g., from .github/copilot-instructions.md) */
	customInstructions?: string;
	/** Mode: 'agent' (default) or 'codesearch' */
	mode?: 'agent' | 'codesearch';
}

/**
 * Context passed to tool handlers
 */
export interface ToolContext {
	// Terminal state
	copilotTerminal: ManagedTerminal | undefined;
	userTerminals: Map<string, ManagedTerminal>;
	activeUserTerminalId: string | undefined;

	// File state
	trackedOpenFiles: Map<string, TrackedOpenFile>;
	activeFileUri: string | undefined;

	// Utilities
	queueFileWrite: (uri: vscode.Uri, work: () => Promise<void>) => Promise<void>;
	resolveFilePath: (path: string) => vscode.Uri;

	// State setters (for tool handlers to update state)
	setActiveUserTerminalId: (id: string | undefined) => void;
	setActiveFileUri: (uri: string | undefined) => void;
	createUserTerminal: (name?: string) => ManagedTerminal;
	getUserTerminal: (id: string) => ManagedTerminal | undefined;
	getActiveUserTerminal: () => ManagedTerminal | undefined;
	deleteUserTerminal: (id: string) => boolean;
}

/**
 * Tool handler function type
 */
export type ToolHandler = (
	args: Record<string, unknown>,
	context: ToolContext,
	confirm?: boolean
) => Promise<ToolResult>;

/**
 * Tool schema for /tools endpoint
 */
export interface ToolSchema {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}
