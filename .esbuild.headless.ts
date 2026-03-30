/**
 * Headless build script — stripped-down version of .esbuild.ts.
 * Builds only the production extension entry points needed for
 * the headless tools server (no tests, simulations, webviews).
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import { copyFile, mkdir } from 'fs/promises';
import * as path from 'path';

const REPO_ROOT = import.meta.dirname;

const baseBuildOptions = {
	bundle: true,
	logLevel: 'info',
	minify: true,
	outdir: './dist',
	sourcemap: false,
	sourcesContent: false,
	treeShaking: true
} satisfies esbuild.BuildOptions;

const baseNodeBuildOptions = {
	...baseBuildOptions,
	external: [
		'./package.json',
		'./.vscode-test.mjs',
		'playwright',
		'keytar',
		'@azure/functions-core',
		'applicationinsights-native-metrics',
		'@opentelemetry/instrumentation',
		'@azure/opentelemetry-instrumentation-azure-sdk',
		'electron',
		'sqlite3',
		'node-pty',
		'@github/copilot',
	],
	platform: 'node',
	mainFields: ["module", "main"],
	define: {
		'process.env.APPLICATIONINSIGHTS_CONFIGURATION_CONTENT': JSON.stringify(JSON.stringify({
			proxyHttpUrl: "",
			proxyHttpsUrl: ""
		}))
	},
} satisfies esbuild.BuildOptions;

const importMetaPlugin: esbuild.Plugin = {
	name: 'claudeAgentSdkImportMetaPlugin',
	setup(build) {
		build.onLoad({ filter: /node_modules[\/\\]@anthropic-ai[\/\\]claude-agent-sdk[\/\\].*\.mjs$/ }, async (args) => {
			const contents = await fs.promises.readFile(args.path, 'utf8');
			return {
				contents: contents.replace(
					/import\.meta\.url/g,
					'require("url").pathToFileURL(__filename).href'
				),
				loader: 'js'
			};
		});
	}
};

const nodeExtHostBuildOptions = {
	...baseNodeBuildOptions,
	entryPoints: [
		{ in: './src/extension/extension/vscode-node/extension.ts', out: 'extension' },
		{ in: './src/platform/parser/node/parserWorker.ts', out: 'worker2' },
		{ in: './src/platform/tokenizer/node/tikTokenizerWorker.ts', out: 'tikTokenizerWorker' },
		{ in: './src/platform/diff/node/diffWorkerMain.ts', out: 'diffWorker' },
		{ in: './src/platform/tfidf/node/tfidfWorker.ts', out: 'tfidfWorker' },
		{ in: './src/extension/onboardDebug/node/copilotDebugWorker/index.ts', out: 'copilotDebugCommand' },
		{ in: './src/extension/chatSessions/vscode-node/copilotCLIShim.ts', out: 'copilotCLIShim' },
	],
	loader: { '.ps1': 'text' },
	plugins: [importMetaPlugin],
	external: [
		...baseNodeBuildOptions.external,
		'vscode'
	]
} satisfies esbuild.BuildOptions;

const typeScriptServerPluginBuildOptions = {
	bundle: true,
	format: 'cjs',
	logLevel: 'info',
	minify: true,
	outdir: './node_modules/@vscode/copilot-typescript-server-plugin/dist',
	platform: 'node',
	sourcemap: false,
	sourcesContent: false,
	treeShaking: true,
	external: [
		"typescript",
		"typescript/lib/tsserverlibrary"
	],
	entryPoints: [
		{ in: './src/extension/typescriptContext/serverPlugin/src/node/main.ts', out: 'main' },
	]
} satisfies esbuild.BuildOptions;

async function typeScriptServerPluginPackageJsonInstall(): Promise<void> {
	await mkdir('./node_modules/@vscode/copilot-typescript-server-plugin', { recursive: true });
	const source = path.join(REPO_ROOT, './src/extension/typescriptContext/serverPlugin/package.json');
	const destination = path.join(REPO_ROOT, './node_modules/@vscode/copilot-typescript-server-plugin/package.json');
	try {
		await copyFile(source, destination);
	} catch (error) {
		console.error('Error copying package.json:', error);
	}
}

function applyPackageJsonPatch() {
	const packagejsonPath = path.join(REPO_ROOT, './package.json');
	const json = JSON.parse(fs.readFileSync(packagejsonPath).toString());

	const newProps: any = {
		buildType: 'prod',
		isPreRelease: false,
	};

	const patchedPackageJson = Object.assign(json, newProps);
	delete patchedPackageJson['scripts'];
	delete patchedPackageJson['devDependencies'];
	delete patchedPackageJson['dependencies'];

	fs.writeFileSync(packagejsonPath, JSON.stringify(patchedPackageJson));
}

async function main() {
	applyPackageJsonPatch();
	await typeScriptServerPluginPackageJsonInstall();

	await Promise.all([
		esbuild.build(nodeExtHostBuildOptions),
		esbuild.build(typeScriptServerPluginBuildOptions),
	]);

	console.log('Headless build complete.');
}

main();
