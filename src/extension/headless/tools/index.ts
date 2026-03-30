/*---------------------------------------------------------------------------------------------
 *  Tool registry and dispatch
 *
 *  Provides a registry of headless-only tools and functions for dispatching to them.
 *--------------------------------------------------------------------------------------------*/

import { ToolHandler, ToolResult, ToolContext } from '../types';
import * as terminalTools from './terminalTools';
import * as fileTools from './fileTools';
import * as webTools from './webTools';

/**
 * List of headless-only tools (checked before toolsService lookup)
 */
export const HEADLESS_ONLY_TOOLS = [
	'create_terminal', 'list_terminals', 'focus_terminal', 'close_terminal',
	'send_to_terminal', 'select_line_range_in_terminal',
	'open_file', 'focus_file', 'list_open_files', 'select_line_range_in_open_file', 'close_file',
	'fetch_webpage',
];

/**
 * Registry of headless-only tools
 */
export const toolRegistry = new Map<string, ToolHandler>([
	// Terminal management tools (headless-only)
	['create_terminal', (args, ctx, confirm) => Promise.resolve(terminalTools.handleCreateTerminal(args, ctx))],
	['list_terminals', (args, ctx, confirm) => Promise.resolve(terminalTools.handleListTerminals(args, ctx))],
	['focus_terminal', (args, ctx, confirm) => Promise.resolve(terminalTools.handleFocusTerminal(args, ctx))],
	['close_terminal', (args, ctx, confirm) => Promise.resolve(terminalTools.handleCloseTerminal(args, ctx))],
	['send_to_terminal', terminalTools.handleSendToTerminal],
	['select_line_range_in_terminal', (args, ctx, confirm) => Promise.resolve(terminalTools.handleSelectLineRangeInTerminal(args, ctx))],

	// File management tools (headless-only)
	['open_file', fileTools.handleOpenFile],
	['focus_file', fileTools.handleFocusFile],
	['close_file', fileTools.handleCloseFile],
	['list_open_files', (args, ctx, confirm) => Promise.resolve(fileTools.handleListOpenFiles(args, ctx))],
	['select_line_range_in_open_file', fileTools.handleSelectLineRangeInOpenFile],

	// Web tools (headless-only)
	['fetch_webpage', (args, ctx, confirm) => webTools.handleFetchWebpage(args)],
]);

/**
 * Tools that are handled in fallback path (after toolsService check)
 * because they might have VS Code implementations but need headless handling
 */
export const FALLBACK_HEADLESS_TOOLS = new Map<string, ToolHandler>([
	['run_in_terminal', terminalTools.handleRunInTerminal],
	['terminal_last_command', (args, ctx, confirm) => Promise.resolve(terminalTools.handleTerminalLastCommand(args, ctx))],
	['terminal_selection', (args, ctx, confirm) => Promise.resolve(terminalTools.handleTerminalSelection(args, ctx))],
	['get_terminal_output', (args, ctx, confirm) => Promise.resolve(terminalTools.handleGetTerminalOutput(args, ctx))],
	// Also include headless-only tools for fallback in case they reach here
	['create_terminal', (args, ctx, confirm) => Promise.resolve(terminalTools.handleCreateTerminal(args, ctx))],
	['list_terminals', (args, ctx, confirm) => Promise.resolve(terminalTools.handleListTerminals(args, ctx))],
	['focus_terminal', (args, ctx, confirm) => Promise.resolve(terminalTools.handleFocusTerminal(args, ctx))],
	['close_terminal', (args, ctx, confirm) => Promise.resolve(terminalTools.handleCloseTerminal(args, ctx))],
	['fetch_webpage', (args, ctx, confirm) => webTools.handleFetchWebpage(args)],
]);

/**
 * Check if a tool is headless-only
 */
export function isHeadlessOnlyTool(toolName: string): boolean {
	return HEADLESS_ONLY_TOOLS.includes(toolName);
}

/**
 * Invoke a headless-only tool
 * Returns null if the tool is not in the registry
 */
export async function invokeHeadlessOnlyTool(
	toolName: string,
	args: Record<string, unknown>,
	context: ToolContext,
	confirm?: boolean
): Promise<ToolResult | null> {
	const handler = toolRegistry.get(toolName);
	if (!handler) return null;
	return handler(args, context, confirm);
}

/**
 * Invoke a fallback tool
 * Returns null if the tool is not in the fallback registry
 */
export async function invokeFallbackTool(
	toolName: string,
	args: Record<string, unknown>,
	context: ToolContext,
	confirm?: boolean
): Promise<ToolResult | null> {
	const handler = FALLBACK_HEADLESS_TOOLS.get(toolName);
	if (!handler) return null;
	return handler(args, context, confirm);
}

// Re-export schemas
export { getHeadlessToolSchemas } from './schemas';
