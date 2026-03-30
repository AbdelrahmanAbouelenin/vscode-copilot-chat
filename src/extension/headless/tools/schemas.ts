/*---------------------------------------------------------------------------------------------
 *  Tool schemas for headless-only tools
 *
 *  These schemas are returned by the /tools endpoint for tools that are only
 *  available in headless mode (not registered in toolsService).
 *--------------------------------------------------------------------------------------------*/

import { ToolSchema } from '../types';

/**
 * Custom headless terminal management tool schemas
 */
export const headlessTerminalToolSchemas: ToolSchema[] = [
	{
		name: 'create_terminal',
		description: 'Create a new terminal. The new terminal becomes the active terminal.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Name for the terminal (optional)' },
				cwd: { type: 'string', description: 'Initial working directory (optional)' }
			}
		}
	},
	{
		name: 'list_terminals',
		description: 'List all terminals and show which one is active.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'focus_terminal',
		description: 'Set a terminal as the active terminal.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Terminal ID to focus' }
			},
			required: ['id']
		}
	},
	{
		name: 'close_terminal',
		description: 'Close a terminal.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Terminal ID to close' }
			},
			required: ['id']
		}
	},
	{
		name: 'send_to_terminal',
		description: 'Run a command in a user terminal (not Copilot\'s terminal). Simulates user typing in their terminal.',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'Command to execute' },
				id: { type: 'string', description: 'Terminal ID (optional, uses active terminal if not specified)' }
			},
			required: ['command']
		}
	},
	{
		name: 'select_line_range_in_terminal',
		description: 'Select a range of lines in the terminal output. Useful for highlighting specific output.',
		inputSchema: {
			type: 'object',
			properties: {
				startLine: { type: 'number', description: 'Start line number (1-indexed)' },
				endLine: { type: 'number', description: 'End line number (1-indexed)' },
				id: { type: 'string', description: 'Terminal ID (optional, uses active terminal if not specified)' }
			},
			required: ['startLine', 'endLine']
		}
	}
];

/**
 * Custom headless file management tool schemas
 */
export const headlessFileToolSchemas: ToolSchema[] = [
	{
		name: 'open_file',
		description: 'Open a file in the editor. The file becomes the active file.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path to the file to open (relative to workspace or absolute)' }
			},
			required: ['path']
		}
	},
	{
		name: 'focus_file',
		description: 'Focus an already open file, making it the active file.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path to the file to focus' }
			},
			required: ['path']
		}
	},
	{
		name: 'list_open_files',
		description: 'List all open files and show which one is active.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'select_line_range_in_open_file',
		description: 'Select a range of lines in the currently active or specified open file.',
		inputSchema: {
			type: 'object',
			properties: {
				startLine: { type: 'number', description: 'Start line number (1-indexed)' },
				endLine: { type: 'number', description: 'End line number (1-indexed)' },
				path: { type: 'string', description: 'Path to the file (optional, uses active file if not specified)' }
			},
			required: ['startLine', 'endLine']
		}
	},
	{
		name: 'close_file',
		description: 'Close an open file.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path to the file to close (optional, closes active file if not specified)' }
			}
		}
	}
];

/**
 * Get all headless-only tool schemas
 */
export function getHeadlessToolSchemas(): ToolSchema[] {
	return [...headlessTerminalToolSchemas, ...headlessFileToolSchemas];
}
