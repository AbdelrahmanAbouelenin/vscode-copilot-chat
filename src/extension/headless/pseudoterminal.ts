/*---------------------------------------------------------------------------------------------
 *  Headless pseudoterminal implementation
 *
 *  A Pseudoterminal that executes commands via child_process for headless mode.
 *  This allows VS Code's terminal infrastructure to work without a real terminal UI.
 *  Also tracks command history and output for terminal_last_command and get_terminal_output tools.
 *--------------------------------------------------------------------------------------------*/

import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { Emitter } from '../../util/vs/base/common/event';
import { ExecutedCommand, IHeadlessPseudoterminal } from './types';
import { MAX_COMMAND_HISTORY, MAX_OUTPUT_BUFFER } from './constants';

const execAsync = promisify(exec);

export class HeadlessPseudoterminal implements IHeadlessPseudoterminal {
	private readonly _onDidWrite = new Emitter<string>();
	readonly onDidWrite = this._onDidWrite.event;

	private readonly _onDidClose = new Emitter<number | void>();
	readonly onDidClose = this._onDidClose.event;

	private cwd: string;
	private commandQueue: Array<{ command: string; timeoutMs?: number; resolve: (output: string) => void; reject: (err: Error) => void }> = [];
	private isOpen = false;

	// Track command history and output for terminal tools
	private _commandHistory: ExecutedCommand[] = [];
	private _outputBuffer: string[] = [];

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	open(): void {
		this.isOpen = true;
		const msg = `Headless terminal ready (cwd: ${this.cwd})\r\n`;
		this._onDidWrite.fire(msg);
		this.appendOutput(msg);
		this.processQueue();
	}

	close(): void {
		this.isOpen = false;
	}

	handleInput(data: string): void {
		// Echo input back (for interactive commands)
		this._onDidWrite.fire(data);
	}

	/**
	 * Execute a command and return the output
	 */
	async executeCommand(command: string, timeoutMs?: number): Promise<string> {
		return new Promise((resolve, reject) => {
			this.commandQueue.push({ command, timeoutMs, resolve, reject });
			if (this.isOpen) {
				this.processQueue();
			}
		});
	}

	private async processQueue(): Promise<void> {
		while (this.commandQueue.length > 0) {
			const item = this.commandQueue.shift()!;
			const startTime = Date.now();
			let exitCode: number | undefined = 0;
			let output = '';

			try {
				const cmdLine = `$ ${item.command}\r\n`;
				this._onDidWrite.fire(cmdLine);
				this.appendOutput(cmdLine);

				output = await this.runCommand(item.command, item.timeoutMs);
				const outputLine = output.replace(/\n/g, '\r\n') + '\r\n';
				this._onDidWrite.fire(outputLine);
				this.appendOutput(outputLine);

				item.resolve(output);
			} catch (err: any) {
				const errorMsg = err.message || String(err);
				const errorLine = `Error: ${errorMsg}\r\n`;
				this._onDidWrite.fire(errorLine);
				this.appendOutput(errorLine);
				output = errorMsg;
				exitCode = 1;
				item.reject(err);
			}

			// Track command in history
			this._commandHistory.push({
				command: item.command,
				output,
				cwd: this.cwd,
				exitCode,
				timestamp: startTime,
			});
			if (this._commandHistory.length > MAX_COMMAND_HISTORY) {
				this._commandHistory.shift();
			}
		}
	}

	private appendOutput(text: string): void {
		this._outputBuffer.push(text);
		if (this._outputBuffer.length > MAX_OUTPUT_BUFFER) {
			this._outputBuffer.shift();
		}
	}

	private async runCommand(command: string, timeoutMs?: number): Promise<string> {
		const resolvedTimeout = timeoutMs === 0
			? undefined
			: (typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined);

		const execOptions: ExecOptions = {
			cwd: this.cwd,
			timeout: resolvedTimeout,
			maxBuffer: 10 * 1024 * 1024,
			env: process.env,
		};

		try {
			const { stdout, stderr } = await execAsync(command, execOptions);
			return (stdout + (stderr ? `\n${stderr}` : '')).trim() || '(no output)';
		} catch (err: any) {
			const stdout = err.stdout ?? '';
			const stderr = err.stderr ?? '';
			const output = (stdout + (stderr ? `\n${stderr}` : '')).trim();
			throw new Error(`Exit code ${err.code ?? 'unknown'}${output ? `: ${output}` : ''}`);
		}
	}

	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	getCwd(): string {
		return this.cwd;
	}

	/**
	 * Get the last executed command (for terminal_last_command tool)
	 */
	getLastCommand(): ExecutedCommand | undefined {
		return this._commandHistory.at(-1);
	}

	/**
	 * Get command history
	 */
	getCommandHistory(): ExecutedCommand[] {
		return [...this._commandHistory];
	}

	/**
	 * Get terminal output buffer (for get_terminal_output tool)
	 */
	getOutputBuffer(maxChars: number = 16000): string {
		const joined = this._outputBuffer.join('');
		const start = Math.max(0, joined.length - maxChars);
		return joined.slice(start);
	}
}
