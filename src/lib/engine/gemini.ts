/**
 * Gemini API client wrapper.
 *
 * Rules (from claude_banana experience):
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

let clientInstance: GoogleGenAI | null = null;
let currentApiKey: string | null = null;

function getClient(apiKey: string): GoogleGenAI {
	if (clientInstance && currentApiKey === apiKey) return clientInstance;
	clientInstance = new GoogleGenAI({ apiKey });
	currentApiKey = apiKey;
	return clientInstance;
}

// ── Shared helpers ──

/**
 * Retrieve chat history, falling back to manual construction if the SDK
 * method isn't available.
 */
function getChatHistory(
	chat: Chat,
	fallbackHistory: Content[],
	userParts: Part[],
	modelParts: Part[]
): Content[] {
	if (chat.getHistory) return chat.getHistory();
	return [
		...fallbackHistory,
		{ role: 'user', parts: userParts },
		{ role: 'model', parts: modelParts }
	];
}

// ── Exported types ──

export interface ParsedTextResponse {
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
	text: string;
	imageData: Uint8Array;
	mimeType: string;
	history: Content[];
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
	userParts: Part[],
	history: Content[] = [],
	config?: GenerateContentConfig
): Promise<{
	stream: AsyncGenerator<StreamChunk>;
	getResult: () => Promise<ParsedTextResponse>;
}> {
	// TODO: remove before shipping
	const debugParts = userParts.map((p) => {
		if ('inlineData' in p && p.inlineData) return { inlineData: `[${p.inlineData.mimeType}]` };
		if ('functionResponse' in p && p.functionResponse) return { functionResponse: p.functionResponse };
		return p;
	});
	console.log(`[gemini] >>> ${modelId} | history: ${history.length} | parts:`, debugParts);

	const client = getClient(apiKey);
	const chat: Chat = client.chats.create({
		model: modelId,
		history,
		config
	});

	const responseStream = await chat.sendMessageStream({ message: userParts });

	let fullText = '';
	const allFunctionCalls: FunctionCall[] = [];
	let consumed = false;

	// Gemini models emit junk text parts at the boundary between thought/
	// function-call parts and the real response (digits, ",thought", etc.).
	// We skip text parts that arrive before real content if they contain
	// no letters. Once a part with actual prose arrives, everything flows
	// through unfiltered.
	let hadRealText = false;

	let chunkIndex = 0;

	async function* stream(): AsyncGenerator<StreamChunk> {
		for await (const chunk of responseStream) {
			const parts = chunk.candidates?.[0]?.content?.parts ?? [];
			const out: StreamChunk = {};

			// TODO: remove before shipping
			const debugChunkParts = parts.map((p) => ({
				...(p.text !== undefined && { text: p.text.slice(0, 120) + (p.text.length > 120 ? '...' : '') }),
				...(p.thought && { thought: true }),
				...(p.thoughtSignature && { sig: true }),
				...(p.functionCall && { fn: p.functionCall.name, args: p.functionCall.args }),
				...(('inlineData' in p && p.inlineData) && { img: p.inlineData.mimeType }),
			}));
			console.log(`[gemini] chunk ${chunkIndex++}:`, debugChunkParts);

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
					if (!hadRealText && !/[a-zA-Z]/.test(part.text) && part.text.length < 10) {
						// Short junk token before real content (e.g. ",", "2"); skip it.
						continue;
					}
					let text = part.text;
					if (!hadRealText) {
						// First real text part: strip any thought delimiter prefix.
						text = text.replace(/^[\s,\-\d]*thought\b\s*/i, '');
						if (!text) continue;
					}
					hadRealText = true;
					out.textDelta = (out.textDelta ?? '') + text;
					fullText += text;
				}
			}

			if (out.textDelta || out.thoughtDelta || out.functionCalls) {
				yield out;
			}
		}
		consumed = true;
	}

	async function getResult(): Promise<ParsedTextResponse> {
		if (!consumed) {
			throw new Error('Stream must be fully consumed before calling getResult()');
		}
		// TODO: remove before shipping
		console.log(`[gemini] <<< text: ${fullText.length} chars | functionCalls: ${allFunctionCalls.map((fc) => fc.name).join(', ') || 'none'}`);
		return {
			text: fullText,
			functionCalls: allFunctionCalls,
			history: getChatHistory(chat, history, userParts, [{ text: fullText }])
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
		history?: Content[];
		inputImages?: Array<{ data: string; mimeType: string }>;
		aspectRatio?: string;
	} = {}
): Promise<GeminiImageResponse> {
	const client = getClient(apiKey);

	const config: GenerateContentConfig = {};
	if (options.aspectRatio) {
		config.imageConfig = { aspectRatio: options.aspectRatio };
	}

	const chat: Chat = client.chats.create({
		model: modelId,
		history: options.history ?? [],
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

	let text = '';
	let imageData: Uint8Array | null = null;
	let mimeType = 'image/png';

	if (response.candidates?.[0]?.content?.parts) {
		for (const part of response.candidates[0].content.parts) {
			if (part.text && !part.thought) {
				text += part.text;
			} else if (part.inlineData && !imageData) {
				imageData = part.inlineData.data as unknown as Uint8Array;
				mimeType = part.inlineData.mimeType ?? 'image/png';
			}
		}
	}

	if (!imageData) {
		throw new Error('Image model did not return an image. Response text: ' + text);
	}

	const responseParts = response.candidates?.[0]?.content?.parts ?? [];

	return {
		text,
		imageData,
		mimeType,
		history: getChatHistory(chat, options.history ?? [], parts, responseParts)
	};
}
