/*---------------------------------------------------------------------------------------------
 *  Web tool handlers
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import { ToolResult } from '../types';
import { truncateToolResult, extractTextFromHtml } from '../utils';
import { WEB_FETCH_TIMEOUT_MS } from '../constants';

/**
 * Handle fetch_webpage - fetch web page content
 * Headless implementation using Node.js http/https modules
 *
 * Output format matches VS Code's FetchWebPageTool:
 * - "Here is some relevant context from the web page {url}:\n{content}"
 * - "Invalid URL so no data was provided: {url}" for failures
 */
export async function handleFetchWebpage(
	args: Record<string, unknown>
): Promise<ToolResult> {
	const urls = args.urls as string[] | undefined;
	const query = args.query as string | undefined;

	if (!urls || urls.length === 0) {
		return { success: false, error: 'No URLs provided' };
	}

	console.log(`[HeadlessTools] Fetching ${urls.length} webpage(s)${query ? ` for query: "${query}"` : ''}...`);

	const results: string[] = [];
	const invalidUrls: string[] = [];

	for (const url of urls) {
		try {
			const content = await fetchUrlContent(url);
			// Format matches WebPageContentChunks in fetchWebPageTool.tsx
			results.push(`Here is some relevant context from the web page ${url}:\n${content}`);
		} catch (err: any) {
			console.error(`[HeadlessTools] Failed to fetch ${url}:`, err.message);
			invalidUrls.push(url);
		}
	}

	// Add invalid URLs at the end (matches WebPageResults in fetchWebPageTool.tsx)
	for (const url of invalidUrls) {
		results.push(`Invalid URL so no data was provided: ${url}`);
	}

	if (results.length === 0) {
		return { success: false, error: 'Failed to fetch any URLs' };
	}

	// Apply truncation to the combined results following the same format as the extension
	return { success: true, result: truncateToolResult(results.join('\n\n')) };
}

/**
 * Fetch URL content and extract text
 */
async function fetchUrlContent(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const protocol = parsedUrl.protocol === 'https:' ? https : http;

		const options = {
			hostname: parsedUrl.hostname,
			port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
			path: parsedUrl.pathname + parsedUrl.search,
			method: 'GET',
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; VSCode-Copilot-Headless/1.0)',
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			},
			timeout: WEB_FETCH_TIMEOUT_MS,
		};

		const req = protocol.request(options, (res) => {
			// Handle redirects
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				fetchUrlContent(res.headers.location)
					.then(resolve)
					.catch(reject);
				return;
			}

			if (res.statusCode && res.statusCode >= 400) {
				reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
				return;
			}

			const chunks: Buffer[] = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => {
				const html = Buffer.concat(chunks).toString('utf-8');
				const text = extractTextFromHtml(html);
				// Apply truncation following the same format as the extension
				resolve(truncateToolResult(text));
			});
			res.on('error', reject);
		});

		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy();
			reject(new Error('Request timeout'));
		});
		req.end();
	});
}
