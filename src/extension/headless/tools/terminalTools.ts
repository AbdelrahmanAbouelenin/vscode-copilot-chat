/*---------------------------------------------------------------------------------------------
 *  Terminal tool handlers
 *--------------------------------------------------------------------------------------------*/

import { ToolResult, ToolContext } from '../types';
import { truncateToolResult } from '../utils';

type BackgroundCommandStatus = 'running' | 'finished' | 'error';

interface BackgroundCommand {
	id: string;
	command: string;
	startedAt: number;
	status: BackgroundCommandStatus;
	output?: string;
	error?: string;
}

const backgroundCommands = new Map<string, BackgroundCommand>();

function generateTerminalId(): string {
	const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
	return template.replace(/[xy]/g, char => {
		const random = Math.floor(Math.random() * 16);
		const value = char === 'x' ? random : (random & 0x3) | 0x8;
		return value.toString(16);
	});
}

/**
 * Handle run_in_terminal using Copilot's dedicated terminal
 * This is separate from user terminals - like how VS Code's Copilot has its own terminal
 */
export async function handleRunInTerminal(
	args: Record<string, unknown>,
	context: ToolContext,
	confirm?: boolean
): Promise<ToolResult> {
	const command = args.command as string;
	const explanation = args.explanation as string | undefined;
	const cwd = args.cwd as string | undefined;
	const isBackground = args.isBackground as boolean | undefined;
	const timeout = args.timeout as number | undefined;

	if (!command) {
		return { success: false, error: 'No command provided' };
	}

	if (!explanation || !explanation.trim()) {
		return { success: false, error: 'Missing required argument: explanation' };
	}

	if (typeof isBackground !== 'boolean') {
		return { success: false, error: 'Missing required argument: isBackground' };
	}

	if (!confirm) {
		return {
			success: false,
			error: `Confirmation required: Run terminal command. ${explanation || command}. Pass "confirm": true to approve.`
		};
	}

	if (!context.copilotTerminal) {
		return { success: false, error: 'Copilot terminal not initialized' };
	}

	// Update cwd if specified
	if (cwd) {
		context.copilotTerminal.pty.setCwd(cwd);
	}

	console.log(`[HeadlessTools] Executing in Copilot terminal: ${command}`);

	try {
		if (isBackground) {
			const commandId = generateTerminalId();
			const backgroundCommand: BackgroundCommand = {
				id: commandId,
				command,
				startedAt: Date.now(),
				status: 'running',
			};
			backgroundCommands.set(commandId, backgroundCommand);

			void context.copilotTerminal.pty.executeCommand(command)
				.then(output => {
					backgroundCommand.status = 'finished';
					backgroundCommand.output = output;
				})
				.catch((err: any) => {
					backgroundCommand.status = 'error';
					backgroundCommand.error = err?.message || String(err);
				});

			return {
				success: true,
				result: commandId
			};
		}

		const commandPromise = context.copilotTerminal.pty.executeCommand(command);
		if (typeof timeout === 'number' && timeout > 0) {
			const commandOutcomePromise: Promise<{ kind: 'output'; output: string } | { kind: 'error'; error: unknown }> =
				commandPromise
					.then(output => ({ kind: 'output', output } as const))
					.catch(error => ({ kind: 'error', error } as const));

			const timeoutPromise: Promise<{ kind: 'timeout' }> = new Promise(resolve => {
				setTimeout(() => resolve({ kind: 'timeout' }), timeout);
			});

			const raceResult = await Promise.race([commandOutcomePromise, timeoutPromise]);

			if (raceResult.kind === 'timeout') {
				void commandPromise.catch(() => undefined);
				return {
					success: false,
					msg: 'reached timeout before command completed'
				};
			}

			if (raceResult.kind === 'error') {
				const err = raceResult.error as any;
				return {
					success: false,
					error: err?.message || String(err)
				};
			}

			return {
				success: true,
				result: truncateToolResult(raceResult.output)
			};
		}

		const output = await commandPromise;
		return {
			success: true,
			result: truncateToolResult(output)
		};
	} catch (err: any) {
		return {
			success: false,
			error: err.message || String(err)
		};
	}
}

/**
 * Handle terminal_last_command - get the last executed command from active USER terminal
 * Note: This reads from USER terminals, not Copilot's terminal
 *
 * Format matches VS Code's TerminalLastCommand prompt element:
 * - "The following is the last command run in the terminal:" + commandLine
 * - "It was run in the directory:" + cwd
 * - "It has the following output:" + output
 */
export function handleTerminalLastCommand(
	_args: Record<string, unknown>,
	context: ToolContext
): ToolResult {
	if (context.userTerminals.size === 0) {
		return { success: true, result: '' };
	}

	const terminal = context.getActiveUserTerminal();
	if (!terminal) {
		return { success: true, result: '' };
	}

	const lastCmd = terminal.pty.getLastCommand();
	if (!lastCmd) {
		return { success: true, result: '' };
	}

	// Match the format from terminalLastCommand.tsx
	const parts: string[] = [];
	if (lastCmd.command) {
		parts.push('The following is the last command run in the terminal:');
		parts.push(lastCmd.command);
	}
	if (lastCmd.cwd) {
		parts.push('It was run in the directory:');
		parts.push(lastCmd.cwd);
	}
	if (lastCmd.output) {
		parts.push('It has the following output:');
		parts.push(lastCmd.output);
	}

	// Apply truncation following the same format as the extension
	return { success: true, result: truncateToolResult(parts.join('\n')) };
}

/**
 * Handle terminal_selection - get current terminal selection
 * In headless mode, there's no selection, so we return empty string
 * (matches VS Code's getActiveTerminalSelection which returns terminal.selection ?? '')
 */
export function handleTerminalSelection(
	_args: Record<string, unknown>,
	_context: ToolContext
): ToolResult {
	return { success: true, result: '' };
}

/**
 * Handle get_terminal_output - get terminal output buffer from active USER terminal
 * Note: This reads from USER terminals, not Copilot's terminal
 * Returns raw terminal buffer (matches VS Code's getActiveTerminalBuffer)
 */
export function handleGetTerminalOutput(
	args: Record<string, unknown>,
	context: ToolContext
): ToolResult {
	const terminalId = args.id as string | undefined;
	const maxChars = 16000;

	if (!terminalId) {
		return { success: false, error: 'Terminal ID is required' };
	}

	const command = backgroundCommands.get(terminalId);
	if (command) {
		if (command.status === 'error') {
			return {
				success: true,
				result: command.error ? truncateToolResult(command.error) : undefined
			};
		}

		if (command.status === 'finished') {
			if (!command.output || command.output.trim() === '') {
				return { success: true, result: undefined };
			}
			return {
				success: true,
				result: truncateToolResult(command.output)
			};
		}

		return { success: true, result: undefined };
	}

	if (terminalId === 'copilot') {
		if (!context.copilotTerminal) {
			return { success: true, result: '' };
		}
		const output = context.copilotTerminal.pty.getOutputBuffer(maxChars);
		return { success: true, result: truncateToolResult(output || '') };
	}

	// Get target user terminal
	const terminal = context.getUserTerminal(terminalId);

	if (!terminal) {
		return { success: true, result: '' };
	}

	const output = terminal.pty.getOutputBuffer(maxChars);
	// Apply truncation following the same format as the extension
	return { success: true, result: truncateToolResult(output || '') };
}

/**
 * Handle create_terminal - create a new user terminal
 */
export function handleCreateTerminal(
	args: Record<string, unknown>,
	context: ToolContext
): ToolResult {
	const name = args.name as string | undefined;
	const cwd = args.cwd as string | undefined;

	const terminal = context.createUserTerminal(name);

	if (cwd) {
		terminal.pty.setCwd(cwd);
	}

	return {
		success: true,
		result: `Created user terminal "${terminal.name}" (${terminal.id}). It is now the active user terminal.`
	};
}

/**
 * Handle list_terminals - list all user terminals (not Copilot's terminal)
 */
export function handleListTerminals(
	_args: Record<string, unknown>,
	context: ToolContext
): ToolResult {
	const terminals = Array.from(context.userTerminals.values()).map(t => ({
		id: t.id,
		name: t.name,
		isActive: t.id === context.activeUserTerminalId,
	}));

	const lines: string[] = [];

	// Show Copilot terminal info
	if (context.copilotTerminal) {
		lines.push('Copilot Terminal: [run_in_terminal uses this]');
	}

	lines.push('');
	lines.push('User Terminals:');

	if (terminals.length === 0) {
		lines.push('  (none - create with create_terminal)');
	} else {
		for (const t of terminals) {
			lines.push(`${t.isActive ? '→ ' : '  '}${t.name} (${t.id})${t.isActive ? ' [active]' : ''}`);
		}
	}

	return {
		success: true,
		result: lines.join('\n')
	};
}

/**
 * Handle focus_terminal - set the active user terminal
 */
export function handleFocusTerminal(
	args: Record<string, unknown>,
	context: ToolContext
): ToolResult {
	const terminalId = args.id as string;

	if (!terminalId) {
		return { success: false, error: 'Terminal ID is required' };
	}

	const terminal = context.getUserTerminal(terminalId);
	if (!terminal) {
		return { success: false, error: `User terminal not found: ${terminalId}` };
	}

	context.setActiveUserTerminalId(terminalId);
	console.log(`[HeadlessTools] Active user terminal set to: ${terminalId}`);

	return {
		success: true,
		result: `Focused user terminal "${terminal.name}" (${terminalId})`
	};
}

/**
 * Handle close_terminal - close a user terminal
 */
export function handleCloseTerminal(
	args: Record<string, unknown>,
	context: ToolContext
): ToolResult {
	const terminalId = args.id as string;

	if (!terminalId) {
		return { success: false, error: 'Terminal ID is required' };
	}

	const terminal = context.getUserTerminal(terminalId);
	if (!terminal) {
		return { success: false, error: `User terminal not found: ${terminalId}` };
	}

	terminal.terminal.dispose();
	context.deleteUserTerminal(terminalId);

	// If we closed the active terminal, pick a new one
	if (context.activeUserTerminalId === terminalId) {
		const remaining = Array.from(context.userTerminals.keys());
		context.setActiveUserTerminalId(remaining.length > 0 ? remaining[0] : undefined);
	}

	return {
		success: true,
		result: `Closed user terminal "${terminal.name}" (${terminalId})`
	};
}

/**
 * Handle select_line_range_in_terminal - select lines in terminal output
 */
export function handleSelectLineRangeInTerminal(
	args: Record<string, unknown>,
	context: ToolContext
): ToolResult {
	const startLine = args.startLine as number;
	const endLine = args.endLine as number;
	const terminalId = args.id as string | undefined;

	if (!startLine || !endLine) {
		return { success: false, error: 'startLine and endLine are required' };
	}

	if (startLine < 1 || endLine < startLine) {
		return { success: false, error: 'Invalid line range. startLine must be >= 1 and endLine >= startLine' };
	}

	const terminal = terminalId
		? context.getUserTerminal(terminalId)
		: context.getActiveUserTerminal();

	if (!terminal) {
		if (context.userTerminals.size === 0) {
			return { success: false, error: 'No user terminals exist. Create one with create_terminal first.' };
		}
		return { success: false, error: `User terminal not found: ${terminalId}` };
	}

	// Store the selection in the terminal
	terminal.selectedLineRange = { start: startLine, end: endLine };

	// Get the selected lines from output buffer
	const output = terminal.pty.getOutputBuffer();
	const lines = output.split('\n');
	const selectedLines = lines.slice(startLine - 1, endLine);

	return {
		success: true,
		result: `Selected lines ${startLine}-${endLine} in terminal "${terminal.name}":\n${selectedLines.join('\n')}`
	};
}

/**
 * Handle send_to_terminal - run a command in a user terminal
 * This simulates a user typing a command in their terminal
 */
export async function handleSendToTerminal(
	args: Record<string, unknown>,
	context: ToolContext,
	confirm?: boolean
): Promise<ToolResult> {
	const command = args.command as string;
	const terminalId = args.id as string | undefined;

	if (!command) {
		return { success: false, error: 'Command is required' };
	}

	if (!confirm) {
		return {
			success: false,
			error: `Confirmation required: Run "${command}" in user terminal. Pass "confirm": true to approve.`
		};
	}

	// Get target user terminal
	const terminal = terminalId
		? context.getUserTerminal(terminalId)
		: context.getActiveUserTerminal();

	if (!terminal) {
		if (context.userTerminals.size === 0) {
			return { success: false, error: 'No user terminals exist. Create one with create_terminal first.' };
		}
		return { success: false, error: `User terminal not found: ${terminalId}` };
	}

	console.log(`[HeadlessTools] Executing in user terminal ${terminal.id}: ${command}`);

	try {
		const output = await terminal.pty.executeCommand(command);
		// Apply truncation following the same format as the extension
		return {
			success: true,
			result: truncateToolResult(`[${terminal.name}] ${output}`)
		};
	} catch (err: any) {
		return {
			success: false,
			error: `[${terminal.name}] ${err.message || String(err)}`
		};
	}
}
