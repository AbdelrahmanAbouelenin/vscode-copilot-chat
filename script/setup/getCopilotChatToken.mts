/*---------------------------------------------------------------------------------------------
 *  Mints a VSCODE_COPILOT_CHAT_TOKEN from a GITHUB_OAUTH_TOKEN.
 *
 *  Usage:
 *    1. First run `pnpm run get_token` to get GITHUB_OAUTH_TOKEN in .env
 *    2. Then run `npx tsx script/setup/getCopilotChatToken.mts`
 *    3. The base64 encoded token will be printed and saved to .env
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Load .env file
dotenv.config();

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';

interface TokenInfo {
	token: string;
	expires_at: number;
	refresh_in: number;
	organization_list?: string[];
	code_quote_enabled?: boolean;
	public_suggestions?: string;
	telemetry?: string;
	copilotignore_enabled?: boolean;
	endpoints?: { api: string; telemetry: string; proxy: string; 'origin-tracker'?: string };
	chat_enabled?: boolean;
	limited_user_quotas?: { chat: number; completions: number };
	enterprise_list?: number[];
	individual?: boolean;
	sku?: string;
	message?: string;
}

interface CopilotUserInfo {
	copilot_plan: string;
	quota_snapshots?: any;
	quota_reset_date?: string;
	codex_agent_enabled?: boolean;
}

interface ExtendedTokenInfo extends TokenInfo {
	username: string;
	isVscodeTeamMember: boolean;
	copilot_plan: string;
	quota_snapshots?: any;
	quota_reset_date?: string;
	codex_agent_enabled?: boolean;
	blackbird_clientside_indexing?: boolean;
}

async function main(): Promise<void> {
	const githubToken = process.env.GITHUB_OAUTH_TOKEN;

	if (!githubToken) {
		console.error('Error: GITHUB_OAUTH_TOKEN not found in environment or .env file');
		console.error('Run `pnpm run get_token` first to get a GitHub OAuth token');
		process.exit(1);
	}

	console.log('Fetching Copilot token...');

	// Fetch Copilot token
	const tokenResponse = await fetch(COPILOT_TOKEN_URL, {
		method: 'GET',
		headers: {
			'Authorization': `token ${githubToken}`,
			'Accept': 'application/json',
			'X-GitHub-Api-Version': '2025-04-01',
		},
	});

	if (!tokenResponse.ok) {
		console.error(`Error fetching Copilot token: ${tokenResponse.status} ${tokenResponse.statusText}`);
		const text = await tokenResponse.text();
		console.error(text);
		process.exit(1);
	}

	const tokenInfo = (await tokenResponse.json()) as TokenInfo;

	if (!tokenInfo.token) {
		console.error('Error: No token in response');
		console.error(tokenInfo);
		process.exit(1);
	}

	console.log('Fetching user info...');

	// Fetch user info
	let userInfo: CopilotUserInfo | undefined;
	try {
		const userResponse = await fetch(COPILOT_USER_URL, {
			method: 'GET',
			headers: {
				'Authorization': `token ${githubToken}`,
				'Accept': 'application/json',
				'X-GitHub-Api-Version': '2025-04-01',
			},
		});

		if (userResponse.ok) {
			userInfo = (await userResponse.json()) as CopilotUserInfo;
		}
	} catch (e) {
		console.warn('Warning: Could not fetch user info, continuing without it');
	}

	// Get GitHub username
	let username = 'unknown';
	try {
		const userApiResponse = await fetch('https://api.github.com/user', {
			headers: {
				'Authorization': `token ${githubToken}`,
				'Accept': 'application/json',
			},
		});
		if (userApiResponse.ok) {
			const userData = (await userApiResponse.json()) as { login?: string };
			username = userData.login || 'unknown';
		}
	} catch (e) {
		console.warn('Warning: Could not fetch GitHub username');
	}

	// Extend token info - set expires_at far in the future to avoid refresh
	const extendedTokenInfo: ExtendedTokenInfo = {
		...tokenInfo,
		// Override expires_at to far future (1 year from now) to prevent refresh attempts
		expires_at: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60),
		refresh_in: 365 * 24 * 60 * 60,
		username,
		isVscodeTeamMember: false,
		copilot_plan: userInfo?.copilot_plan || tokenInfo.sku || 'unknown',
		quota_snapshots: userInfo?.quota_snapshots,
		quota_reset_date: userInfo?.quota_reset_date,
		codex_agent_enabled: userInfo?.codex_agent_enabled,
	};

	// Base64 encode
	const encoded = Buffer.from(JSON.stringify(extendedTokenInfo)).toString('base64');

	console.log('\n=== VSCODE_COPILOT_CHAT_TOKEN ===\n');
	console.log(encoded);
	console.log('\n=================================\n');

	// Print some info
	console.log('Token info:');
	console.log(`  Username: ${username}`);
	console.log(`  SKU: ${tokenInfo.sku || 'unknown'}`);
	console.log(`  Plan: ${extendedTokenInfo.copilot_plan}`);
	console.log(`  Chat enabled: ${tokenInfo.chat_enabled}`);
	console.log(`  Original expires_at: ${new Date(tokenInfo.expires_at * 1000).toISOString()}`);
	console.log(`  Modified expires_at: ${new Date(extendedTokenInfo.expires_at * 1000).toISOString()} (1 year from now)`);

	// Save to .env
	const envPath = '.env';
	const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
	const result = raw.split('\n')
		.filter(line => !line.startsWith('VSCODE_COPILOT_CHAT_TOKEN='))
		.concat([`VSCODE_COPILOT_CHAT_TOKEN=${encoded}`])
		.filter(line => line.trim() !== '')
		.join('\n');

	fs.writeFileSync(envPath, result);
	console.log('\nWrote VSCODE_COPILOT_CHAT_TOKEN to .env');

	// Also output for easy copy
	console.log('\nTo use in Modal secrets, add this environment variable:');
	console.log(`  VSCODE_COPILOT_CHAT_TOKEN=${encoded}`);
}

main().catch(e => {
	console.error('Error:', e);
	process.exit(1);
});
