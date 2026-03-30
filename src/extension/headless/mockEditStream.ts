/*---------------------------------------------------------------------------------------------
 *  Mock edit stream for capturing file edits
 *
 *  Creates a mock stream that captures file edits from tool invocations
 *  and applies them using VS Code's WorkspaceEdit API.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TextEdit } from '../../vscodeTypes';
import { deduplicateEdits } from './utils';

/**
 * Create a mock stream that captures file edits
 *
 * @param queueFileWrite Function to serialize file writes
 * @param pendingEdits Map to collect pending edits by file URI
 * @param pendingWrites Array to track pending write promises
 * @returns Mock stream object
 */
export function createMockStream(
	queueFileWrite: (uri: vscode.Uri, work: () => Promise<void>) => Promise<void>,
	pendingEdits: Map<string, { edits: TextEdit[]; uri: vscode.Uri }>,
	pendingWrites: Promise<void>[]
): any {
	/**
	 * Apply pending edits to a file using VS Code's WorkspaceEdit API.
	 * This ensures the in-memory TextDocument stays in sync with disk.
	 * Uses the file write queue to serialize edits to the same file.
	 */
	const applyAndWriteEdits = async (uri: vscode.Uri, edits: TextEdit[]): Promise<void> => {
		return queueFileWrite(uri, async () => {
			// Deduplicate edits before applying
			const uniqueEdits = deduplicateEdits(edits);
			if (uniqueEdits.length === 0) {
				return;
			}

			console.log(`[HeadlessTools] Applying ${uniqueEdits.length} edits to: ${uri.fsPath}`);

			// Build WorkspaceEdit with text edits
			const wsEdit = new vscode.WorkspaceEdit();
			// Create file if it doesn't exist (ignoreIfExists: true means no-op if it does)
			wsEdit.createFile(uri, { ignoreIfExists: true });
			for (const e of uniqueEdits) {
				wsEdit.replace(
					uri,
					new vscode.Range(
						e.range.start.line, e.range.start.character,
						e.range.end.line, e.range.end.character
					),
					e.newText
				);
			}

			// Apply edits via VS Code
			const success = await vscode.workspace.applyEdit(wsEdit);
			if (!success) {
				throw new Error(`WorkspaceEdit failed for ${uri.fsPath}`);
			}

			// Save to persist to disk
			const doc = await vscode.workspace.openTextDocument(uri);
			if (doc.isDirty) {
				await doc.save();
			}

			console.log(`[HeadlessTools] Applied and saved edits to: ${uri.fsPath}`);
		});
	};

	/**
	 * Flush all pending edits for all files.
	 * Uses snapshot-and-delete to avoid race where new edits arrive during await.
	 */
	const flushAll = async (): Promise<void> => {
		// Snapshot current entries and delete them from the map BEFORE awaiting
		// This way, any new edits that arrive during the await will go into fresh entries
		const snapshot: Array<{ uri: vscode.Uri; edits: TextEdit[] }> = [];
		for (const [uriStr, pending] of pendingEdits) {
			if (pending.edits.length > 0) {
				snapshot.push({ uri: pending.uri, edits: [...pending.edits] }); // Copy edits array
			}
			pendingEdits.delete(uriStr); // Delete before await
		}

		if (snapshot.length > 0) {
			await Promise.all(snapshot.map(s => applyAndWriteEdits(s.uri, s.edits)));
		}
	};

	const mockStream = {
		markdown: () => mockStream,
		text: () => mockStream,
		progress: () => { },
		warning: () => { },
		reference: () => mockStream,
		anchor: () => mockStream,
		button: () => mockStream,
		filetree: () => mockStream,

		textEdit: (uri: vscode.Uri, editsOrComplete: any) => {
			const uriStr = uri.toString();

			if (editsOrComplete === true) {
				// Flush and delete: take ownership of pending edits, then remove from map
				const pending = pendingEdits.get(uriStr);
				pendingEdits.delete(uriStr); // Delete first to avoid race
				if (pending && pending.edits.length > 0) {
					const writePromise = applyAndWriteEdits(pending.uri, [...pending.edits]);
					pendingWrites.push(writePromise);
				}
				return;
			}

			if (typeof editsOrComplete === 'boolean' || !editsOrComplete) {
				return;
			}

			const edits: TextEdit[] = Array.isArray(editsOrComplete) ? editsOrComplete : [editsOrComplete];
			if (!pendingEdits.has(uriStr)) {
				pendingEdits.set(uriStr, { edits: [], uri });
			}
			const pending = pendingEdits.get(uriStr)!;

			for (const edit of edits) {
				if (edit && edit.range && edit.newText !== undefined) {
					pending.edits.push(edit);
				}
			}
		},
		notebookEdit: () => { },
		codeblockUri: () => { },

		push: (part: any) => {
			if (part && part.uri && (part.edits !== undefined || part.isDone)) {
				const uri = part.uri;
				const uriStr = uri.toString();

				if (part.isDone) {
					// Flush and delete: take ownership of pending edits, then remove from map
					const pending = pendingEdits.get(uriStr);
					pendingEdits.delete(uriStr); // Delete first to avoid race
					if (pending && pending.edits.length > 0) {
						const writePromise = applyAndWriteEdits(pending.uri, [...pending.edits]);
						pendingWrites.push(writePromise);
					}
				} else if (part.edits && Array.isArray(part.edits)) {
					if (!pendingEdits.has(uriStr)) {
						pendingEdits.set(uriStr, { edits: [], uri });
					}
					const pending = pendingEdits.get(uriStr)!;
					for (const edit of part.edits) {
						if (edit && edit.range && edit.newText !== undefined) {
							pending.edits.push(edit);
						}
					}
				}
			}
			return mockStream;
		},
		clearToPreviousToolInvocation: () => { },
		close: () => {
			// Flush all pending edits when stream is closed
			const flushPromise = flushAll();
			pendingWrites.push(flushPromise);
		},
		confirmation: () => { },
	};

	return mockStream;
}
