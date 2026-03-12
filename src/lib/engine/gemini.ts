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
	Type,
	type Chat,
	type Content,
	type FunctionCall,
	type FunctionDeclaration,
	type GenerateContentConfig,
	type Part
} from '@google/genai';

// ── Tool declarations for native function calling ──

export const toolDeclarations: FunctionDeclaration[] = [
	{
		name: 'generate_image',
		description:
			'Generate or transform an image. For new images, write a full scene prompt. For edits or transformations of existing images, pass the source image in reference_image_ids and write a short directive prompt describing what to change.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				prompt: {
					type: Type.STRING,
					description: 'Detailed image generation prompt incorporating project context.'
				},
				label: {
					type: Type.STRING,
					description: 'Short human-readable label for the image (e.g. "forest_clearing").'
				},
				aspect_ratio: {
					type: Type.STRING,
					description:
						'Aspect ratio. One of: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9. Defaults to 1:1.'
				},
				reference_image_ids: {
					type: Type.ARRAY,
					items: { type: Type.STRING },
					description:
						'IDs of project images to use as visual input. Use for style reference, character consistency, image editing, or combining elements. Always pair with prompt instructions explaining how each image should be used.'
				}
			},
			required: ['prompt', 'label']
		}
	},
	{
		name: 'view_image',
		description:
			'View a project image by its ID. Returns the image so you can see its contents. Use this when you need to reference, compare, or iterate on a previous image.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				image_id: {
					type: Type.STRING,
					description: 'The ID of the image to view (from the project images index).'
				},
				reason: {
					type: Type.STRING,
					description: 'Brief note on why you need to see this image (helps the user follow your thinking).'
				}
			},
			required: ['image_id']
		}
	},
	{
		name: 'read_memory',
		description:
			'Read the full content of a project memory topic by its slug. Use this to recall established decisions before making changes.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				topic: {
					type: Type.STRING,
					description: 'The slug of the memory topic to read (from the memory index in the system prompt).'
				}
			},
			required: ['topic']
		}
	},
	{
		name: 'update_memory',
		description:
			'Create, update, or delete a project memory topic. All fields are required on every call to keep the index coherent. To delete a topic, pass empty content.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				topic: {
					type: Type.STRING,
					description:
						'Slug for the topic. Use lowercase-kebab-case, e.g. "art-style", "characters", "world-rules". Must be unique within the project.'
				},
				title: {
					type: Type.STRING,
					description: 'Human-readable title for the topic.'
				},
				summary: {
					type: Type.STRING,
					description: '1-2 sentence summary shown in the memory index. Should capture the essence of the topic.'
				},
				content: {
					type: Type.STRING,
					description: 'Full markdown content. Pass empty string to delete the topic.'
				}
			},
			required: ['topic', 'title', 'summary', 'content']
		}
	}
];

// ── Client singleton ──

let clientInstance: GoogleGenAI | null = null;
let currentApiKey: string | null = null;

function getClient(apiKey: string): GoogleGenAI {
	if (clientInstance && currentApiKey === apiKey) return clientInstance;
	clientInstance = new GoogleGenAI({ apiKey });
	currentApiKey = apiKey;
	return clientInstance;
}

// ── Response parsing helpers ──

export interface ParsedTextResponse {
	text: string;
	functionCalls: FunctionCall[];
	history: Content[];
}

// ── Text / orchestration messaging ──

/** A chunk emitted during streaming. */
export interface StreamChunk {
	textDelta?: string;
	thoughtDelta?: string;
	functionCalls?: FunctionCall[];
}

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
					if (!hadRealText && !/[a-zA-Z]/.test(part.text)) {
						// Junk token before real content; skip it.
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
			history: chat.getHistory
				? await chat.getHistory()
				: [
						...history,
						{ role: 'user', parts: userParts },
						{ role: 'model', parts: [{ text: fullText }] }
					]
		};
	}

	return { stream: stream(), getResult };
}

// ── Image generation (unchanged, no function calling needed here) ──

export interface GeminiImageResponse {
	text: string;
	imageData: Uint8Array;
	mimeType: string;
	history: Content[];
}

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
		imageSize?: string;
	} = {}
): Promise<GeminiImageResponse> {
	const client = getClient(apiKey);

	const config: GenerateContentConfig = {};
	if (options.aspectRatio || options.imageSize) {
		config.imageConfig = {};
		if (options.aspectRatio) config.imageConfig.aspectRatio = options.aspectRatio;
		if (options.imageSize) config.imageConfig.imageSize = options.imageSize;
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

	return {
		text,
		imageData,
		mimeType,
		history: chat.getHistory
			? await chat.getHistory()
			: [
					...(options.history ?? []),
					{ role: 'user', parts },
					{ role: 'model', parts: response.candidates?.[0]?.content?.parts ?? [] }
				]
	};
}

// ── Utility ──

/**
 * Convert a Blob to a base64 string suitable for the Gemini API.
 */
export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			resolve(result.split(',')[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

/**
 * Convert base64 or Uint8Array image data from the API response to a Blob.
 */
export function imageDataToBlob(data: Uint8Array | string, mimeType: string): Blob {
	if (typeof data === 'string') {
		const binary = atob(data);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new Blob([bytes], { type: mimeType });
	}
	return new Blob([data as BlobPart], { type: mimeType });
}
