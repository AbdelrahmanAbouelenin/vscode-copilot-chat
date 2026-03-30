/*---------------------------------------------------------------------------------------------
 *  File tool handlers
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ToolResult, ToolContext } from '../types';

/**
 * Handle open_file - open a file in the editor
 */
export async function handleOpenFile(
	args: Record<string, unknown>,
	context: ToolContext
): Promise<ToolResult> {
	const path = args.path as string;

	if (!path) {
		return { success: false, error: 'Path is required' };
	}

	try {
		// Resolve the file path
		const fileUri = context.resolveFilePath(path);

		// Try to open the document
		const doc = await vscode.workspace.openTextDocument(fileUri);
		await vscode.window.showTextDocument(doc);

		// Track the open file
		const uriStr = fileUri.toString();
		context.trackedOpenFiles.set(uriStr, { uri: fileUri });
		context.setActiveFileUri(uriStr);

		console.log(`[HeadlessTools] Opened file: ${fileUri.fsPath}`);
		return {
			success: true,
			result: `Opened file: ${fileUri.fsPath} (${doc.lineCount} lines)`
		};
	} catch (err: any) {
		return { success: false, error: `Failed to open file: ${err.message}` };
	}
}

/**
 * Handle focus_file - focus an already open file
 */
export async function handleFocusFile(
	args: Record<string, unknown>,
	context: ToolContext
): Promise<ToolResult> {
	const path = args.path as string;

	if (!path) {
		return { success: false, error: 'Path is required' };
	}

	try {
		const fileUri = context.resolveFilePath(path);
		const uriStr = fileUri.toString();

		// Check if file is tracked as open
		if (!context.trackedOpenFiles.has(uriStr)) {
			// Try to open it first
			const doc = await vscode.workspace.openTextDocument(fileUri);
			await vscode.window.showTextDocument(doc);
			context.trackedOpenFiles.set(uriStr, { uri: fileUri });
		} else {
			// Show the already open document
			const doc = await vscode.workspace.openTextDocument(fileUri);
			await vscode.window.showTextDocument(doc);
		}

		context.setActiveFileUri(uriStr);

		console.log(`[HeadlessTools] Focused file: ${fileUri.fsPath}`);
		return {
			success: true,
			result: `Focused file: ${fileUri.fsPath}`
		};
	} catch (err: any) {
		return { success: false, error: `Failed to focus file: ${err.message}` };
	}
}

/**
 * Handle list_open_files - list all open files
 */
export function handleListOpenFiles(
	_args: Record<string, unknown>,
	context: ToolContext
): ToolResult {
	const lines: string[] = ['Open files:'];

	if (context.trackedOpenFiles.size === 0) {
		lines.push('  (none - open files with open_file)');
	} else {
		for (const [uriStr, tracked] of context.trackedOpenFiles) {
			const isActive = uriStr === context.activeFileUri;
			const relativePath = vscode.workspace.asRelativePath(tracked.uri);
			const selection = tracked.selectedLineRange
				? ` [selected: lines ${tracked.selectedLineRange.start}-${tracked.selectedLineRange.end}]`
				: '';
			lines.push(`${isActive ? '→ ' : '  '}${relativePath}${isActive ? ' [active]' : ''}${selection}`);
		}
	}

	return {
		success: true,
		result: lines.join('\n')
	};
}

/**
 * Handle select_line_range_in_open_file - select lines in an open file
 */
export async function handleSelectLineRangeInOpenFile(
	args: Record<string, unknown>,
	context: ToolContext
): Promise<ToolResult> {
	const startLine = args.startLine as number;
	const endLine = args.endLine as number;
	const path = args.path as string | undefined;

	if (!startLine || !endLine) {
		return { success: false, error: 'startLine and endLine are required' };
	}

	if (startLine < 1 || endLine < startLine) {
		return { success: false, error: 'Invalid line range. startLine must be >= 1 and endLine >= startLine' };
	}

	let targetUri: vscode.Uri;
	let uriStr: string;

	if (path) {
		targetUri = context.resolveFilePath(path);
		uriStr = targetUri.toString();
	} else if (context.activeFileUri) {
		uriStr = context.activeFileUri;
		const tracked = context.trackedOpenFiles.get(uriStr);
		if (!tracked) {
			return { success: false, error: 'Active file not found' };
		}
		targetUri = tracked.uri;
	} else {
		return { success: false, error: 'No active file. Open a file first or specify a path.' };
	}

	try {
		// Open and show the document with the selection
		const doc = await vscode.workspace.openTextDocument(targetUri);
		const editor = await vscode.window.showTextDocument(doc);

		// Create the selection (VS Code uses 0-indexed lines)
		const startPos = new vscode.Position(startLine - 1, 0);
		const endPos = new vscode.Position(endLine - 1, doc.lineAt(Math.min(endLine - 1, doc.lineCount - 1)).text.length);
		const selection = new vscode.Selection(startPos, endPos);

		editor.selection = selection;
		editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);

		// Update tracking
		const tracked = context.trackedOpenFiles.get(uriStr);
		if (tracked) {
			tracked.selectedLineRange = { start: startLine, end: endLine };
		}

		// Get the selected text
		const selectedText = doc.getText(new vscode.Range(startPos, endPos));
		const previewLength = 200;
		const preview = selectedText.length > previewLength
			? selectedText.slice(0, previewLength) + '...'
			: selectedText;

		return {
			success: true,
			result: `Selected lines ${startLine}-${endLine} in ${vscode.workspace.asRelativePath(targetUri)}:\n${preview}`
		};
	} catch (err: any) {
		return { success: false, error: `Failed to select lines: ${err.message}` };
	}
}

/**
 * Handle close_file - close an open file
 */
export async function handleCloseFile(
	args: Record<string, unknown>,
	context: ToolContext
): Promise<ToolResult> {
	const path = args.path as string | undefined;

	let targetUri: vscode.Uri | undefined;
	let uriStr: string | undefined;

	if (path) {
		targetUri = context.resolveFilePath(path);
		uriStr = targetUri.toString();
	} else if (context.activeFileUri) {
		uriStr = context.activeFileUri;
		const tracked = context.trackedOpenFiles.get(uriStr);
		if (tracked) {
			targetUri = tracked.uri;
		}
	}

	if (!targetUri || !uriStr) {
		return { success: false, error: 'No file to close. Specify a path or have an active file.' };
	}

	try {
		// Find the tab with this file and close it
		for (const tabGroup of vscode.window.tabGroups.all) {
			for (const tab of tabGroup.tabs) {
				if (tab.input instanceof vscode.TabInputText) {
					if (tab.input.uri.toString() === uriStr) {
						await vscode.window.tabGroups.close(tab);
						break;
					}
				}
			}
		}

		// Remove from tracking
		const relativePath = vscode.workspace.asRelativePath(targetUri);
		context.trackedOpenFiles.delete(uriStr);

		// Update active file if we closed it
		if (context.activeFileUri === uriStr) {
			const remaining = Array.from(context.trackedOpenFiles.keys());
			context.setActiveFileUri(remaining.length > 0 ? remaining[0] : undefined);
		}

		console.log(`[HeadlessTools] Closed file: ${targetUri.fsPath}`);
		return {
			success: true,
			result: `Closed file: ${relativePath}`
		};
	} catch (err: any) {
		return { success: false, error: `Failed to close file: ${err.message}` };
	}
}
