/*---------------------------------------------------------------------------------------------
 *  Prompt building utilities
 *
 *  Builds system prompts and context for the LLM, mirroring the VS Code
 *  Copilot Chat extension's DefaultAgentPrompt and AgentUserMessage.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ContextRequest, SystemPromptRequest, ToolResult, ToolContext, ManagedTerminal } from './types';
import { WORKSPACE_DEPTH_LIMIT, WORKSPACE_LINE_LIMIT } from './constants';

/**
 * Type for the invokeTool function to avoid circular dependencies
 */
export type InvokeToolFn = (
	toolName: string,
	args: Record<string, unknown>,
	confirm: boolean
) => Promise<ToolResult>;

/**
 * Build terminal state context (mirrors TerminalStatePromptElement)
 */
export function buildTerminalStateContext(
	userTerminals: Map<string, ManagedTerminal>,
	activeUserTerminalId: string | undefined,
	terminalId?: string
): string | undefined {
	if (userTerminals.size === 0) {
		return undefined;
	}

	const terminals: { name: string; lastCommand?: { commandLine: string; cwd: string; exitCode: number | undefined } }[] = [];

	if (terminalId) {
		// Specific terminal requested
		const terminal = userTerminals.get(terminalId);
		if (terminal) {
			const lastCmd = terminal.pty.getLastCommand();
			terminals.push({
				name: terminal.name,
				lastCommand: lastCmd ? {
					commandLine: lastCmd.command,
					cwd: lastCmd.cwd,
					exitCode: lastCmd.exitCode,
				} : undefined
			});
		}
	} else {
		// All user terminals
		for (const terminal of userTerminals.values()) {
			const lastCmd = terminal.pty.getLastCommand();
			terminals.push({
				name: terminal.name,
				lastCommand: lastCmd ? {
					commandLine: lastCmd.command,
					cwd: lastCmd.cwd,
					exitCode: lastCmd.exitCode,
				} : undefined
			});
		}
	}

	if (terminals.length === 0) {
		return undefined;
	}

	// Format matches TerminalStatePromptElement output
	const lines: string[] = ['Terminals:'];
	for (const term of terminals) {
		lines.push(`Terminal: ${term.name}`);
		if (term.lastCommand) {
			lines.push(`Last Command: ${term.lastCommand.commandLine ?? '(no last command)'}`);
			lines.push(`Cwd: ${term.lastCommand.cwd ?? '(unknown)'}`);
			lines.push(`Exit Code: ${term.lastCommand.exitCode ?? '(unknown)'}`);
		}
	}

	return lines.join('\n');
}

/**
 * Build todo list context by invoking the manage_todo_list tool with read operation.
 * Matches the behavior of TodoListContextProvider.getCurrentTodoContext() exactly:
 *   if (!todoList.trim() || todoList === 'No todo list found.') {
 *       return undefined;
 *   }
 * The result is then wrapped in <Tag name='todoList'> by TodoListContextPrompt.
 */
export async function buildTodoListContext(invokeTool: InvokeToolFn): Promise<string | undefined> {
	try {
		const result = await invokeTool('manage_todo_list', { operation: 'read' }, true);
		if (result.success && result.result) {
			const content = typeof result.result === 'string' ? result.result : String(result.result);
			// Match the exact check from todoListContextProvider.ts:
			// if (!todoList.trim() || todoList === 'No todo list found.') { return undefined; }
			if (!content.trim() || content === 'No todo list found.') {
				return undefined;
			}
			return `<todoList>\n${content}\n</todoList>`;
		}
	} catch (err) {
		// If we can't get the todo list, just skip it (matches catch block in original)
		console.log('[HeadlessTools] Could not fetch todo list for context:', err);
	}
	return undefined;
}

/**
 * Build editor context (mirrors CurrentEditorContext)
 */
export function buildEditorContext(context: ToolContext): string | undefined {
	if (!context.activeFileUri) {
		return undefined;
	}

	const tracked = context.trackedOpenFiles.get(context.activeFileUri);
	if (!tracked) {
		return undefined;
	}

	const relativePath = vscode.workspace.asRelativePath(tracked.uri);
	let editorCtx = `The user's current file is ${relativePath}.`;

	if (tracked.selectedLineRange) {
		const { start, end } = tracked.selectedLineRange;
		editorCtx += ` The current selection is from line ${start} to line ${end}.`;
	}

	return editorCtx;
}

/**
 * Build a simple workspace structure (directory tree)
 */
export async function buildWorkspaceStructure(
	rootUri: vscode.Uri,
	maxLines: number = WORKSPACE_LINE_LIMIT
): Promise<string | undefined> {
	const lines: string[] = [];

	const walkDir = async (uri: vscode.Uri, prefix: string, depth: number): Promise<void> => {
		if (lines.length >= maxLines || depth > WORKSPACE_DEPTH_LIMIT) {
			return;
		}

		try {
			const entries = await vscode.workspace.fs.readDirectory(uri);
			// Sort: directories first, then files
			entries.sort((a, b) => {
				if (a[1] === b[1]) return a[0].localeCompare(b[0]);
				return a[1] === vscode.FileType.Directory ? -1 : 1;
			});

			for (const [name, type] of entries) {
				if (lines.length >= maxLines) {
					lines.push(`${prefix}...`);
					return;
				}

				// Skip hidden files/dirs and common non-essential directories
				if (name.startsWith('.') ||
					name === 'node_modules' ||
					name === '__pycache__' ||
					name === 'venv' ||
					name === '.venv' ||
					name === 'dist' ||
					name === 'build' ||
					name === 'target') {
					continue;
				}

				const isDir = type === vscode.FileType.Directory;
				lines.push(`${prefix}${name}${isDir ? '/' : ''}`);

				if (isDir) {
					const childUri = vscode.Uri.joinPath(uri, name);
					await walkDir(childUri, prefix + '  ', depth + 1);
				}
			}
		} catch {
			// Ignore read errors
		}
	};

	await walkDir(rootUri, '', 0);
	return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Build the per-request user message context (mirrors AgentUserMessage in agentPrompt.tsx)
 *
 * This generates the full context that would be sent to the LLM, including:
 * - Attached file contents (ChatVariables)
 * - Current date
 * - Terminal state (from user terminals)
 * - Todo list (if available)
 * - Current editor context (active file and selection)
 * - The user query
 */
export async function buildContext(
	request: ContextRequest,
	context: ToolContext,
	invokeTool: InvokeToolFn
): Promise<ToolResult> {
	if (!request.query) {
		return { success: false, error: 'Query is required' };
	}

	const sections: string[] = [];

	// 1. Attached files (mirrors ChatVariables component)
	if (request.attachedFiles && request.attachedFiles.length > 0) {
		const fileContents: string[] = [];
		for (const file of request.attachedFiles) {
			try {
				const fileUri = context.resolveFilePath(file.path);
				const doc = await vscode.workspace.openTextDocument(fileUri);
				const relativePath = vscode.workspace.asRelativePath(fileUri);

				let content: string;
				if (file.startLine !== undefined && file.endLine !== undefined) {
					// Extract specific line range
					const lines = doc.getText().split('\n');
					const startIdx = Math.max(0, file.startLine - 1);
					const endIdx = Math.min(lines.length, file.endLine);
					const selectedLines = lines.slice(startIdx, endIdx);
					// Add line numbers like the real ChatVariables does
					content = selectedLines.map((line, i) => `${startIdx + i + 1}|${line}`).join('\n');
				} else {
					// Include full file with line numbers
					const lines = doc.getText().split('\n');
					content = lines.map((line, i) => `${i + 1}|${line}`).join('\n');
				}

				// Format matches FileVariable in chatVariables.tsx
				const languageId = doc.languageId || 'plaintext';
				const lineRange = (file.startLine !== undefined && file.endLine !== undefined)
					? ` (lines ${file.startLine}-${file.endLine})`
					: '';

				fileContents.push(
					`<file path="${relativePath}"${lineRange}>\n` +
					`\`\`\`${languageId}\n${content}\n\`\`\`\n` +
					`</file>`
				);
			} catch (err: any) {
				fileContents.push(`<file path="${file.path}" error="Failed to read: ${err.message}" />`);
			}
		}

		if (fileContents.length > 0) {
			sections.push('<attachedFiles>\n' + fileContents.join('\n\n') + '\n</attachedFiles>');
		}
	}

	// 2. Context section (mirrors the <Tag name='context'> in AgentUserMessage)
	const contextParts: string[] = [];

	// Current date (matches CurrentDatePrompt)
	const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
	contextParts.push(`The current date is ${dateStr}.`);

	// Terminal state (matches TerminalStatePromptElement)
	const terminalState = buildTerminalStateContext(
		context.userTerminals,
		context.activeUserTerminalId,
		request.terminalId
	);
	if (terminalState) {
		contextParts.push(terminalState);
	}

	// Todo list (matches TodoListContextPrompt)
	if (request.includeTodoList !== false) {
		const todoContext = await buildTodoListContext(invokeTool);
		if (todoContext) {
			contextParts.push(todoContext);
		}
	}

	if (contextParts.length > 0) {
		sections.push('<context>\n' + contextParts.join('\n\n') + '\n</context>');
	}

	// 3. Editor context (matches CurrentEditorContext)
	const editorCtx = buildEditorContext(context);
	if (editorCtx) {
		sections.push('<editorContext>\n' + editorCtx + '\n</editorContext>');
	}

	// 4. User request (matches the final Tag in AgentUserMessage)
	sections.push(`<userRequest>\n${request.query}\n</userRequest>`);

	const fullContext = sections.join('\n\n');

	return {
		success: true,
		result: {
			context: fullContext,
			metadata: {
				attachedFileCount: request.attachedFiles?.length ?? 0,
				hasTerminalState: !!terminalState,
				hasEditorContext: !!editorCtx,
				activeFile: context.activeFileUri ? vscode.workspace.asRelativePath(vscode.Uri.parse(context.activeFileUri)) : null,
				activeTerminal: context.activeUserTerminalId ?? null,
				userTerminalCount: context.userTerminals.size,
			}
		}
	};
}

/**
 * Build the system prompt (mirrors DefaultAgentPrompt in defaultAgentInstructions.tsx)
 *
 * This generates:
 * 1. systemPrompt - Goes in the system message (or first user message for some models)
 * 2. globalContext - Environment and workspace info (sent as first user message)
 */
export async function buildSystemPrompt(
	request: SystemPromptRequest,
	toolsService: { tools: Array<{ name: string }> }
): Promise<ToolResult> {
	const modelName = request.modelName || 'GitHub Copilot';
	const mode = request.mode || 'agent';
	const includeWorkspaceStructure = request.includeWorkspaceStructure !== false;
	const workspaceStructureMaxLines = request.workspaceStructureMaxLines || WORKSPACE_LINE_LIMIT;

	// Get available tools - either from request or from toolsService
	const availableToolNames = new Set(
		request.availableTools || toolsService.tools.map(t => t.name)
	);

	// Build tool capabilities map
	const tools = {
		hasReadFile: availableToolNames.has('read_file'),
		hasReplaceString: availableToolNames.has('replace_string_in_file'),
		hasMultiReplaceString: availableToolNames.has('multi_replace_string_in_file'),
		hasEditFile: availableToolNames.has('edit_file'),
		hasApplyPatch: availableToolNames.has('apply_patch'),
		hasCreateFile: availableToolNames.has('create_file'),
		hasTerminalTool: availableToolNames.has('run_in_terminal'),
		hasCodebase: availableToolNames.has('semantic_search'),
		hasFindTextInFiles: availableToolNames.has('grep_search'),
		hasFindFiles: availableToolNames.has('file_search'),
		hasTodoTool: availableToolNames.has('manage_todo_list'),
		hasEditNotebook: availableToolNames.has('edit_notebook_file'),
		hasRunNotebookCell: availableToolNames.has('run_notebook_cell'),
		hasGetNotebookSummary: availableToolNames.has('copilot_getNotebookSummary'),
		hasGetErrors: availableToolNames.has('get_errors'),
		hasFetchWebPage: availableToolNames.has('fetch_webpage'),
		hasUpdateUserPreferences: availableToolNames.has('update_user_preferences'),
		hasSomeEditTool: availableToolNames.has('replace_string_in_file') ||
			availableToolNames.has('create_file') ||
			availableToolNames.has('edit_file') ||
			availableToolNames.has('apply_patch'),
	};

	const isCodesearchMode = mode === 'codesearch';

	// Build system prompt sections
	const sections: string[] = [];

	// 1. Base intro (matches agentPrompt.tsx line 98)
	sections.push('You are an expert AI programming assistant, working with a user in the VS Code editor.');

	// 2. Copilot Identity Rules (matches copilotIdentity.tsx)
	sections.push(`When asked for your name, you must respond with "GitHub Copilot". When asked about the model you are using, you must state that you are using ${modelName}.`);
	sections.push('Follow the user\'s requirements carefully & to the letter.');

	// 3. Safety Rules (matches safetyRules.tsx)
	sections.push('Follow Microsoft content policies.');
	sections.push('Avoid content that violates copyrights.');
	sections.push('If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can\'t assist with that."');
	sections.push('Keep your answers short and impersonal.');

	// 4. Main instructions (matches defaultAgentInstructions.tsx <instructions> tag)
	const instructionLines: string[] = [];
	instructionLines.push('<instructions>');
	instructionLines.push('You are a highly sophisticated automated coding agent with expert-level knowledge across many different programming languages and frameworks.');
	instructionLines.push('The user will ask a question, or ask you to perform a task, and it may require lots of research to answer correctly. There is a selection of tools that let you perform actions or retrieve helpful context to answer the user\'s question.');

	let attachmentLine = 'You will be given some context and attachments along with the user prompt. You can use them if they are relevant to the task, and ignore them if not.';
	if (tools.hasReadFile) {
		attachmentLine += ' Some attachments may be summarized with omitted sections like `/* Lines 123-456 omitted */`. You can use the read_file tool to read more context if needed. Never pass this omitted line marker to an edit tool.';
	}
	instructionLines.push(attachmentLine);

	instructionLines.push('If you can infer the project type (languages, frameworks, and libraries) from the user\'s query or the context that you have, make sure to keep them in mind when making changes.');

	if (!isCodesearchMode) {
		instructionLines.push('If the user wants you to implement a feature and they have not specified the files to edit, first break down the user\'s request into smaller concepts and think about the kinds of files you need to grasp each concept.');
	}

	instructionLines.push('If you aren\'t sure which tool is relevant, you can call multiple tools. You can call tools repeatedly to take actions or gather as much context as needed until you have completed the task fully. Don\'t give up unless you are sure the request cannot be fulfilled with the tools you have. It\'s YOUR RESPONSIBILITY to make sure that you have done all you can to collect necessary context.');
	instructionLines.push('When reading files, prefer reading large meaningful chunks rather than consecutive small sections to minimize tool calls and gain better context.');
	instructionLines.push('Don\'t make assumptions about the situation- gather context first, then perform the task or answer the question.');

	if (!isCodesearchMode) {
		instructionLines.push('Think creatively and explore the workspace in order to make a complete fix.');
	}

	instructionLines.push('Don\'t repeat yourself after a tool call, pick up where you left off.');

	if (!isCodesearchMode && tools.hasSomeEditTool) {
		instructionLines.push('NEVER print out a codeblock with file changes unless the user asked for it. Use the appropriate edit tool instead.');
	}

	if (tools.hasTerminalTool) {
		instructionLines.push('NEVER print out a codeblock with a terminal command to run unless the user asked for it. Use the run_in_terminal tool instead.');
	}

	instructionLines.push('You don\'t need to read a file if it\'s already provided in context.');
	instructionLines.push('</instructions>');
	sections.push(instructionLines.join('\n'));

	// 5. Tool use instructions (matches <toolUseInstructions> tag)
	const toolUseLines: string[] = [];
	toolUseLines.push('<toolUseInstructions>');
	toolUseLines.push('If the user is requesting a code sample, you can answer it directly without using any tools.');
	toolUseLines.push('When using a tool, follow the JSON schema very carefully and make sure to include ALL required properties.');
	toolUseLines.push('No need to ask permission before using a tool.');
	toolUseLines.push('NEVER say the name of a tool to a user. For example, instead of saying that you\'ll use the run_in_terminal tool, say "I\'ll run the command in a terminal".');

	let parallelLine = 'If you think running multiple tools can answer the user\'s question, prefer calling them in parallel whenever possible';
	if (tools.hasCodebase) {
		parallelLine += ', but do not call semantic_search in parallel.';
	} else {
		parallelLine += '.';
	}
	toolUseLines.push(parallelLine);

	if (tools.hasReadFile) {
		toolUseLines.push('When using the read_file tool, prefer reading a large section over calling the read_file tool many times in sequence. You can also think of all the pieces you may be interested in and read them in parallel. Read large enough context to ensure you get what you need.');
	}

	if (tools.hasCodebase) {
		toolUseLines.push('If semantic_search returns the full contents of the text files in the workspace, you have all the workspace context.');
	}

	if (tools.hasFindTextInFiles) {
		toolUseLines.push('You can use the grep_search to get an overview of a file by searching for a string within that one file, instead of using read_file many times.');
	}

	if (tools.hasCodebase) {
		toolUseLines.push('If you don\'t know exactly the string or filename pattern you\'re looking for, use semantic_search to do a semantic search across the workspace.');
	}

	if (tools.hasTerminalTool) {
		toolUseLines.push('Don\'t call the run_in_terminal tool multiple times in parallel. Instead, run one command and wait for the output before running the next command.');
	}

	if (tools.hasUpdateUserPreferences) {
		toolUseLines.push('After you have performed the user\'s task, if the user corrected something you did, expressed a coding preference, or communicated a fact that you need to remember, use the update_user_preferences tool to save their preferences.');
	}

	toolUseLines.push('When invoking a tool that takes a file path, always use the absolute file path. If the file has a scheme like untitled: or vscode-userdata:, then use a URI with the scheme.');

	if (tools.hasTerminalTool) {
		toolUseLines.push('NEVER try to edit a file by running terminal commands unless the user specifically asks for it.');
	}

	if (!tools.hasSomeEditTool) {
		toolUseLines.push('You don\'t currently have any tools available for editing files. If the user asks you to edit a file, you can ask the user to enable editing tools or print a codeblock with the suggested changes.');
	}

	if (!tools.hasTerminalTool) {
		toolUseLines.push('You don\'t currently have any tools available for running terminal commands. If the user asks you to run a terminal command, you can ask the user to enable terminal tools or print a codeblock with the suggested command.');
	}

	toolUseLines.push('Tools can be disabled by the user. You may see tools used previously in the conversation that are not currently available. Be careful to only use the tools that are currently available to you.');
	toolUseLines.push('</toolUseInstructions>');
	sections.push(toolUseLines.join('\n'));

	// 6. Edit file instructions (if applicable)
	if (tools.hasReplaceString && !tools.hasApplyPatch) {
		const editLines: string[] = [];
		editLines.push('<editFileInstructions>');
		editLines.push('Before you edit an existing file, make sure you either already have it in the provided context, or read it with the read_file tool, so that you can make proper changes.');

		if (tools.hasMultiReplaceString) {
			editLines.push('Use the replace_string_in_file tool for single string replacements, paying attention to context to ensure your replacement is unique. Prefer the multi_replace_string_in_file tool when you need to make multiple string replacements across one or more files in a single operation. This is significantly more efficient than calling replace_string_in_file multiple times and should be your first choice for: fixing similar patterns across files, applying consistent formatting changes, bulk refactoring operations, or any scenario where you need to make the same type of change in multiple places. Do not announce which tool you\'re using (for example, avoid saying "I\'ll implement all the changes using multi_replace_string_in_file").');
		} else {
			editLines.push('Use the replace_string_in_file tool to edit files, paying attention to context to ensure your replacement is unique. You can use this tool multiple times per file.');
		}

		editLines.push('When editing files, group your changes by file.');
		editLines.push('NEVER show the changes to the user, just call the tool, and the edits will be applied and shown to the user.');

		const toolList = tools.hasMultiReplaceString ? 'replace_string_in_file, multi_replace_string_in_file,' : 'replace_string_in_file';
		editLines.push(`NEVER print a codeblock that represents a change to a file, use ${toolList} instead.`);
		editLines.push(`For each file, give a short description of what needs to be changed, then use the ${toolList} tools. You can use any tool multiple times in a response, and you can keep writing text after using a tool.`);

		// Generic editing tips
		if (tools.hasTerminalTool) {
			editLines.push('Follow best practices when editing files. If a popular external library exists to solve a problem, use it and properly install the package e.g. with "npm install" or creating a "requirements.txt".');
		} else {
			editLines.push('Follow best practices when editing files. If a popular external library exists to solve a problem, use it and properly install the package e.g. creating a "requirements.txt".');
		}
		editLines.push('If you\'re building a webapp from scratch, give it a beautiful and modern UI.');
		editLines.push('After editing a file, any new errors in the file will be in the tool result. Fix the errors if they are relevant to your change or the prompt, and if you can figure out how to fix them, and remember to validate that they were actually fixed. Do not loop more than 3 times attempting to fix errors in the same file. If the third try fails, you should stop and ask the user what to do next.');

		editLines.push('</editFileInstructions>');
		sections.push(editLines.join('\n'));
	}

	// 7. Notebook instructions (if applicable)
	if (tools.hasEditNotebook) {
		const notebookLines: string[] = [];
		notebookLines.push('<notebookInstructions>');
		notebookLines.push('To edit notebook files in the workspace, you can use the edit_notebook_file tool.');

		if (tools.hasEditFile) {
			notebookLines.push('Never use the edit_file tool and never execute Jupyter related commands in the Terminal to edit notebook files, such as `jupyter notebook`, `jupyter lab`, `install jupyter` or the like. Use the edit_notebook_file tool instead.');
		}

		if (tools.hasRunNotebookCell) {
			notebookLines.push('Use the run_notebook_cell tool instead of executing Jupyter related commands in the Terminal, such as `jupyter notebook`, `jupyter lab`, `install jupyter` or the like.');
		}

		if (tools.hasGetNotebookSummary) {
			notebookLines.push('Use the copilot_getNotebookSummary tool to get the summary of the notebook (this includes the list or all cells along with the Cell Id, Cell type and Cell Language, execution details and mime types of the outputs, if any).');
		}

		notebookLines.push('Important Reminder: Avoid referencing Notebook Cell Ids in user messages. Use cell number instead.');
		notebookLines.push('Important Reminder: Markdown cells cannot be executed');
		notebookLines.push('</notebookInstructions>');
		sections.push(notebookLines.join('\n'));
	}

	// 8. Output formatting
	const formatLines: string[] = [];
	formatLines.push('<outputFormatting>');
	formatLines.push('Use proper Markdown formatting in your answers. When referring to a filename or symbol in the user\'s workspace, wrap it in backticks.');
	formatLines.push('<example>');
	formatLines.push('The class `Person` is in `src/models/person.ts`.');
	formatLines.push('The function `calculateTotal` is defined in `lib/utils/math.ts`.');
	formatLines.push('You can find the configuration in `config/app.config.json`.');
	formatLines.push('</example>');
	formatLines.push('</outputFormatting>');
	sections.push(formatLines.join('\n'));

	// 9. Custom instructions (if provided)
	if (request.customInstructions) {
		const customLines: string[] = [];
		customLines.push('When generating code, please follow these user provided coding instructions. You can ignore an instruction if it contradicts a system message.');
		customLines.push('<instructions>');
		customLines.push(request.customInstructions);
		customLines.push('</instructions>');
		sections.push(customLines.join('\n'));
	}

	const systemPrompt = sections.join('\n\n');

	// Build global context (sent as first UserMessage)
	const globalContextParts: string[] = [];

	// Environment info
	const osForDisplay = process.platform === 'darwin' ? 'macOS' :
		process.platform === 'win32' ? 'Windows' : 'Linux';
	globalContextParts.push(`<environment_info>\nThe user's current OS is: ${osForDisplay}\n</environment_info>`);

	// Workspace info
	const workspaceInfoParts: string[] = [];
	const folders = vscode.workspace.workspaceFolders || [];

	if (folders.length > 0) {
		workspaceInfoParts.push('I am working in a workspace with the following folders:');
		for (const folder of folders) {
			workspaceInfoParts.push(`- ${folder.uri.fsPath}`);
		}
	} else {
		workspaceInfoParts.push('There is no workspace currently open.');
	}

	// Workspace structure (directory tree)
	if (includeWorkspaceStructure && folders.length > 0) {
		try {
			const structure = await buildWorkspaceStructure(folders[0].uri, workspaceStructureMaxLines);
			if (structure) {
				workspaceInfoParts.push('\nWorkspace structure:');
				workspaceInfoParts.push(structure);
			}
		} catch (err: any) {
			console.log('[HeadlessTools] Could not build workspace structure:', err.message);
		}
	}

	globalContextParts.push(`<workspace_info>\n${workspaceInfoParts.join('\n')}\n</workspace_info>`);

	const globalContext = globalContextParts.join('\n\n');

	return {
		success: true,
		result: {
			systemPrompt,
			globalContext,
			metadata: {
				modelName,
				mode,
				toolCount: availableToolNames.size,
				hasEditTools: tools.hasSomeEditTool,
				hasTerminalTools: tools.hasTerminalTool,
				hasNotebookTools: tools.hasEditNotebook,
				hasWorkspaceStructure: includeWorkspaceStructure,
				hasCustomInstructions: !!request.customInstructions,
				os: osForDisplay,
				workspaceFolders: folders.map(f => f.uri.fsPath),
			}
		}
	};
}
