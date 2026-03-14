/**
 * Gemini API client wrapper.
 *
 * Rules:
 * - Always use chats.create() + chat.sendMessage(), never models.generateContent()
 * - Don't set responseModalities; image models return images by default
 * - Input MIME types: png, jpeg, webp, heic, heif (no gif)
 */
import {
	GoogleGenAI,
	type Chat,
	type Content,
	type FunctionCall,
	type GenerateContentConfig,
	type Part
} from '@google/genai';

// ── Client singleton ──
// Single key assumed; swapping keys replaces the client.

let clientInstance: GoogleGenAI | null = null;
let currentApiKey: string | null = null;

function getClient(apiKey: string): GoogleGenAI {
	if (clientInstance && currentApiKey === apiKey) return clientInstance;
	clientInstance = new GoogleGenAI({ apiKey });
	currentApiKey = apiKey;
	return clientInstance;
}

// ── Exported types ──

export interface ApiTurnResult {
	text: string;
	functionCalls: FunctionCall[];
	history: Content[];
}

/** A chunk emitted during streaming. */
export interface StreamChunk {
	textDelta?: string;
	thoughtDelta?: string;
	functionCalls?: FunctionCall[];
}

export interface GeminiImageResponse {
	imageData: string;
	mimeType: string;
}

// ── Streaming text/tool messaging ──

/**
 * Send a message to the LLM and stream the response.
 *
 * Yields StreamChunks as they arrive. After the generator is exhausted,
 * call getResult() to retrieve the accumulated text, function calls, and
 * updated chat history.
 */
export async function sendMessageStreaming(
	apiKey: string,
	modelId: string,
	messageParts: Part[],
	history: Content[] = [],
	config?: GenerateContentConfig,
	signal?: AbortSignal
): Promise<{
	stream: AsyncGenerator<StreamChunk>;
	getResult: () => ApiTurnResult;
}> {
	const client = getClient(apiKey);
	const chat: Chat = client.chats.create({
		model: modelId,
		history,
		config: signal ? { ...config, abortSignal: signal } : config
	});

	const responseStream = await chat.sendMessageStream({ message: messageParts });

	let fullText = '';
	const allFunctionCalls: FunctionCall[] = [];
	let consumed = false;

	async function* stream(): AsyncGenerator<StreamChunk> {
		for await (const chunk of responseStream) {
			const parts = chunk.candidates?.[0]?.content?.parts ?? [];
			const out: StreamChunk = {};

			for (const part of parts) {
				if (part.functionCall) {
					allFunctionCalls.push(part.functionCall);
					if (!out.functionCalls) out.functionCalls = [];
					out.functionCalls.push(part.functionCall);
				} else if (part.thought || part.thoughtSignature) {
					if (part.text) {
						out.thoughtDelta = (out.thoughtDelta ?? '') + part.text;
					}
				} else if (part.text) {
					out.textDelta = (out.textDelta ?? '') + part.text;
					fullText += part.text;
				}
			}

			if (out.textDelta || out.thoughtDelta || out.functionCalls) {
				yield out;
			}
		}
		consumed = true;
	}

	function getResult(): ApiTurnResult {
		if (!consumed) {
			throw new Error('Stream must be fully consumed before calling getResult()');
		}
		return {
			text: fullText,
			functionCalls: allFunctionCalls,
			// true = curated history (role alternation enforced, thought signatures preserved).
			history: chat.getHistory(true)
		};
	}

	return { stream: stream(), getResult };
}

// ── Image generation ──

/**
 * Generate an image using a Gemini image model.
 */
export async function generateImage(
	apiKey: string,
	modelId: string,
	prompt: string,
	options: {
		inputImages?: Array<{ data: string; mimeType: string }>;
		aspectRatio?: string;
		signal?: AbortSignal;
	} = {}
): Promise<GeminiImageResponse> {
	const client = getClient(apiKey);

	const config: GenerateContentConfig = {};
	if (options.aspectRatio) {
		config.imageConfig = { aspectRatio: options.aspectRatio };
	}
	if (options.signal) {
		config.abortSignal = options.signal;
	}

	const chat: Chat = client.chats.create({
		model: modelId,
		config
	});

	const parts: Part[] = [{ text: prompt }];

	if (options.inputImages) {
		for (const img of options.inputImages) {
			parts.push({
				inlineData: {
					data: img.data,
					mimeType: img.mimeType
				}
			});
		}
	}

	const response = await chat.sendMessage({ message: parts });

	const responseParts = response.candidates?.[0]?.content?.parts ?? [];

	for (const part of responseParts) {
		if (part.inlineData?.data) {
			return {
				imageData: part.inlineData.data,
				mimeType: part.inlineData.mimeType ?? 'image/png'
			};
		}
	}

	const text = responseParts
		.filter((p) => p.text && !p.thought)
		.map((p) => p.text)
		.join('');
	throw new Error('Image model did not return an image. Response text: ' + text);
}
