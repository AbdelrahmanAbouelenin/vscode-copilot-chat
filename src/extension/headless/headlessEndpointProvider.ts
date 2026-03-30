/*---------------------------------------------------------------------------------------------
 *  Headless endpoint provider
 *
 *  Provides mock endpoints for headless mode that support tokenization
 *  without requiring actual Copilot API access.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest, LanguageModelChat } from 'vscode';
import { Raw } from '@vscode/prompt-tsx';
import { ITokenizer, TokenizerType } from '../../util/common/tokenizer';
import { AsyncIterableObject } from '../../util/vs/base/common/async';
import { CancellationToken } from '../../util/vs/base/common/cancellation';
import { ChatFetchResponseType, ChatLocation, ChatResponse } from '../../platform/chat/common/commonTypes';
import { CHAT_MODEL } from '../../platform/configuration/common/configurationService';
import { ChatEndpointFamily, EmbeddingsEndpointFamily, ICompletionModelInformation, IEndpointProvider } from '../../platform/endpoint/common/endpointProvider';
import { FinishedCallback, OptionalChatRequestParams } from '../../platform/networking/common/fetch';
import { Response } from '../../platform/networking/common/fetcherService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEmbeddingsEndpoint, IEndpointBody } from '../../platform/networking/common/networking';
import { ChatCompletion } from '../../platform/networking/common/openai';
import { ITelemetryService, TelemetryProperties } from '../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../platform/telemetry/common/telemetryData';
import { ILogService } from '../../platform/log/common/logService';
import { ITokenizerProvider } from '../../platform/tokenizer/node/tokenizer';
import { Source } from '../../platform/chat/common/chatMLFetcher';

/**
 * A minimal chat endpoint that provides tokenization without making API calls.
 * Used in headless mode where we just need to run tools without actual LLM access.
 */
export class HeadlessChatEndpoint implements IChatEndpoint {
	isPremium = false;
	multiplier = 0;
	restrictedToSkus?: string[] = undefined;
	maxOutputTokens = 128000;
	model = CHAT_MODEL.GPT41;
	supportsToolCalls = true;
	supportsVision = false;
	supportsPrediction = false;
	showInModelPicker = true; // Required for headless mode - otherwise filtered out by languageModelAccess
	isDefault = true;
	isFallback = true;
	policy: 'enabled' | { terms: string } = 'enabled';
	urlOrRequestMetadata = 'headless://mock';
	modelMaxPromptTokens = 128000;
	name = 'headless-mock';
	family = 'gpt-4.1';
	version = '1.0';
	tokenizer = TokenizerType.O200K;

	constructor(
		private readonly _tokenizerProvider: ITokenizerProvider,
	) {}

	acquireTokenizer(): ITokenizer {
		return this._tokenizerProvider.acquireTokenizer(this);
	}

	processResponseFromChatEndpoint(
		_telemetryService: ITelemetryService,
		_logService: ILogService,
		_response: Response,
		_expectedNumChoices: number,
		_finishCallback: FinishedCallback,
		_telemetryData: TelemetryData,
		_cancellationToken?: CancellationToken
	): Promise<AsyncIterableObject<ChatCompletion>> {
		throw new Error('Chat not available in headless mode');
	}

	acceptChatPolicy(): Promise<boolean> {
		return Promise.resolve(true);
	}

	makeChatRequest2(_options: any, _token: CancellationToken): Promise<ChatResponse> {
		// Return an empty success response in headless mode to allow VS Code chat to continue
		return Promise.resolve({
			type: ChatFetchResponseType.Success,
			value: '',
			requestId: 'headless-mock-request',
			serverRequestId: undefined,
			usage: undefined,
			resolvedModel: this.name,
		});
	}

	createRequestBody(_options: ICreateEndpointBodyOptions): IEndpointBody {
		return {
			model: this.model,
			messages: [],
			stream: false,
		};
	}

	makeChatRequest(
		_debugName: string,
		_messages: Raw.ChatMessage[],
		_finishedCb: FinishedCallback | undefined,
		_token: CancellationToken,
		_location: ChatLocation,
		_source?: Source,
		_requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		_userInitiatedRequest?: boolean,
		_telemetryProperties?: TelemetryProperties,
	): Promise<ChatResponse> {
		// Return an empty success response in headless mode
		return Promise.resolve({
			type: ChatFetchResponseType.Success,
			value: '',
			requestId: 'headless-mock-request',
			serverRequestId: undefined,
			usage: undefined,
			resolvedModel: this.name,
		});
	}

	cloneWithTokenOverride(_modelMaxPromptTokens: number): IChatEndpoint {
		return this;
	}

	getExtraHeaders?(): Record<string, string> {
		return {};
	}

	interceptBody?(_body: IEndpointBody | undefined): void {
		// no-op
	}
}

/**
 * Minimal embeddings endpoint for headless mode
 */
class HeadlessEmbeddingsEndpoint implements IEmbeddingsEndpoint {
	id = 'headless-embeddings';
	name = 'headless-embeddings';
	version = '1.0';
	model_picker_enabled = false;
	is_chat_default = false;
	billing = { is_premium: false, multiplier: 0 };
	is_chat_fallback = false;
	capabilities = {
		type: 'embeddings' as const,
		tokenizer: TokenizerType.O200K,
		family: 'headless',
	};
	maxBatchSize = 100;
	urlOrRequestMetadata = 'headless://embeddings';
	modelMaxPromptTokens = 8192;
	family = 'headless';
	tokenizer = TokenizerType.O200K;

	constructor(private readonly _tokenizerProvider: ITokenizerProvider) {}

	acquireTokenizer(): ITokenizer {
		return this._tokenizerProvider.acquireTokenizer({ tokenizer: TokenizerType.O200K } as any);
	}

	async getEmbeddings(_input: string[], _token: CancellationToken): Promise<number[][]> {
		throw new Error('Embeddings not available in headless mode');
	}
}

/**
 * Endpoint provider for headless mode.
 * Returns mock endpoints that support tokenization but not actual API calls.
 */
export class HeadlessEndpointProvider implements IEndpointProvider {
	declare readonly _serviceBrand: undefined;

	private _chatEndpoint: HeadlessChatEndpoint | undefined;
	private _embeddingsEndpoint: HeadlessEmbeddingsEndpoint | undefined;

	constructor(
		@ITokenizerProvider private readonly _tokenizerProvider: ITokenizerProvider,
	) {}

	async getAllCompletionModels(_forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
		return [];
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		return [this.getCachedChatEndpoint()];
	}

	async getChatEndpoint(_requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		return this.getCachedChatEndpoint();
	}

	async getEmbeddingsEndpoint(_family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
		if (!this._embeddingsEndpoint) {
			this._embeddingsEndpoint = new HeadlessEmbeddingsEndpoint(this._tokenizerProvider);
		}
		return this._embeddingsEndpoint;
	}

	private getCachedChatEndpoint(): HeadlessChatEndpoint {
		if (!this._chatEndpoint) {
			this._chatEndpoint = new HeadlessChatEndpoint(this._tokenizerProvider);
		}
		return this._chatEndpoint;
	}
}
