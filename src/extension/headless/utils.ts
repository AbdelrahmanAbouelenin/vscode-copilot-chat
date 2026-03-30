/*---------------------------------------------------------------------------------------------
 *  Pure utility functions for headless tools server
 *--------------------------------------------------------------------------------------------*/

import { TextEdit } from '../../vscodeTypes';
import { MAX_TOOL_RESULT_TOKENS, APPROX_CHARS_PER_TOKEN } from './constants';

/**
 * Truncates tool result content following the same format as VS Code Copilot Chat.
 * Keeps 40% from the beginning and 60% from the end, with a truncation message in between.
 *
 * This mirrors the behavior in toolCalling.tsx ToolResult.onText() exactly:
 *
 *   const truncateAtTokens = this.props.truncate;
 *   if (!truncateAtTokens || content.length < truncateAtTokens) { return content; }
 *   const tokens = await this.endpoint.acquireTokenizer().tokenLength(content);
 *   if (tokens < truncateAtTokens) { return content; }
 *   const approxCharsPerToken = content.length / tokens;
 *   const removedMessage = '\n[Tool response was too long and was truncated.]\n';
 *   const targetChars = Math.round(approxCharsPerToken * (truncateAtTokens - removedMessage.length));
 *   const keepInFirstHalf = Math.round(targetChars * 0.4);
 *   const keepInSecondHalf = targetChars - keepInFirstHalf;
 *   return content.slice(0, keepInFirstHalf) + removedMessage + content.slice(-keepInSecondHalf);
 *
 * @param content The content to truncate
 * @param maxTokens Maximum tokens to allow (default: MAX_TOOL_RESULT_TOKENS, calculated from model context)
 * @returns Truncated content if it exceeds the limit, otherwise the original content
 */
export function truncateToolResult(content: string, maxTokens: number = MAX_TOOL_RESULT_TOKENS): string {
	// Early bail-out: always >= 1 character per token (matches original line 584)
	// Original: if (!truncateAtTokens || content.length < truncateAtTokens) { return content; }
	if (content.length < maxTokens) {
		return content;
	}

	// Estimate tokens since we don't have a real tokenizer in headless mode
	// Original: const tokens = await this.endpoint.acquireTokenizer().tokenLength(content);
	const tokens = content.length / APPROX_CHARS_PER_TOKEN;

	// Original: if (tokens < truncateAtTokens) { return content; }
	if (tokens < maxTokens) {
		return content;
	}

	// Original: const approxCharsPerToken = content.length / tokens;
	const approxCharsPerToken = content.length / tokens;

	// Original: const removedMessage = '\n[Tool response was too long and was truncated.]\n';
	const removedMessage = '\n[Tool response was too long and was truncated.]\n';

	// Original: const targetChars = Math.round(approxCharsPerToken * (truncateAtTokens - removedMessage.length));
	const targetChars = Math.round(approxCharsPerToken * (maxTokens - removedMessage.length));

	// Original: const keepInFirstHalf = Math.round(targetChars * 0.4);
	const keepInFirstHalf = Math.round(targetChars * 0.4);

	// Original: const keepInSecondHalf = targetChars - keepInFirstHalf;
	const keepInSecondHalf = targetChars - keepInFirstHalf;

	// Original: return content.slice(0, keepInFirstHalf) + removedMessage + content.slice(-keepInSecondHalf);
	return content.slice(0, keepInFirstHalf) + removedMessage + content.slice(-keepInSecondHalf);
}

/**
 * Deduplicate edits by (startLine, startChar, endLine, endChar, newText).
 * Keeps first occurrence of each unique edit.
 */
export function deduplicateEdits(edits: TextEdit[]): TextEdit[] {
	const seen = new Set<string>();
	const unique: TextEdit[] = [];

	for (const edit of edits) {
		const key = `${edit.range.start.line}:${edit.range.start.character}-` +
					`${edit.range.end.line}:${edit.range.end.character}:${edit.newText}`;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(edit);
		}
	}

	return unique;
}

/**
 * Extract readable text from HTML
 * Strips tags, scripts, styles, and normalizes whitespace
 */
export function extractTextFromHtml(html: string): string {
	// Remove script and style elements entirely
	let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
	text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');

	// Remove HTML comments
	text = text.replace(/<!--[\s\S]*?-->/g, ' ');

	// Remove all tags
	text = text.replace(/<[^>]+>/g, ' ');

	// Decode common HTML entities
	text = text.replace(/&nbsp;/gi, ' ');
	text = text.replace(/&amp;/gi, '&');
	text = text.replace(/&lt;/gi, '<');
	text = text.replace(/&gt;/gi, '>');
	text = text.replace(/&quot;/gi, '"');
	text = text.replace(/&#39;/gi, "'");
	text = text.replace(/&apos;/gi, "'");

	// Normalize whitespace
	text = text.replace(/\s+/g, ' ');
	text = text.trim();

	return text;
}

/**
 * Validate and extract a string argument
 */
export function validateString(args: Record<string, unknown>, key: string, required = true): string | undefined {
	const value = args[key];
	if (value === undefined) {
		if (required) {
			throw new Error(`${key} is required`);
		}
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new Error(`${key} must be a string`);
	}
	return value;
}

/**
 * Validate and extract a number argument
 */
export function validateNumber(args: Record<string, unknown>, key: string, required = true): number | undefined {
	const value = args[key];
	if (value === undefined) {
		if (required) {
			throw new Error(`${key} is required`);
		}
		return undefined;
	}
	if (typeof value !== 'number') {
		throw new Error(`${key} must be a number`);
	}
	return value;
}

/**
 * Format an error for display
 */
export function formatError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
