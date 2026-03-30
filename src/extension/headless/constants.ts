/*---------------------------------------------------------------------------------------------
 *  Configuration constants for headless tools server
 *--------------------------------------------------------------------------------------------*/

export const PORT = parseInt(process.env.COPILOT_TOOLS_API_PORT || '3001', 10);

/**
 * Model context length in tokens, read from environment variable.
 * Common values: 128000 (Claude/GPT-4), 200000 (Claude 3.5), 32000 (GPT-4-32k)
 * Defaults to 128000 if not specified.
 */
export const MODEL_CONTEXT_LENGTH = parseInt(process.env.COPILOT_MODEL_CONTEXT_LENGTH || '64000', 10);

/**
 * Proportion of the prompt token budget any singular textual tool result is allowed to use.
 * Matches exactly the value in agentPrompt.tsx:
 *   const MAX_TOOL_RESPONSE_PCT = 0.5;
 */
export const MAX_TOOL_RESPONSE_PCT = 0.5;

/**
 * Maximum tokens for tool result truncation, calculated the same way as VS Code:
 *   const maxToolResultLength = Math.floor(this.promptEndpoint.modelMaxPromptTokens * MAX_TOOL_RESPONSE_PCT);
 */
export const MAX_TOOL_RESULT_TOKENS = Math.floor(MODEL_CONTEXT_LENGTH * MAX_TOOL_RESPONSE_PCT);

/**
 * Approximate characters per token (conservative estimate).
 * Real tokenizers vary but ~4 chars/token is a reasonable approximation.
 */
export const APPROX_CHARS_PER_TOKEN = 4;

/** Maximum command history entries */
export const MAX_COMMAND_HISTORY = 50;

/** Maximum output buffer chunks */
export const MAX_OUTPUT_BUFFER = 100;

/** Web fetch timeout (30 seconds) */
export const WEB_FETCH_TIMEOUT_MS = 30000;

/** Max depth for workspace structure */
export const WORKSPACE_DEPTH_LIMIT = 4;

/** Max lines for workspace structure */
export const WORKSPACE_LINE_LIMIT = 100;
