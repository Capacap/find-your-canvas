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
	type GenerateContentResponse,
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
		name: 'update_design_doc',
		description:
			'Update the project design document with new creative decisions. Provide the full updated content (replaces existing).',
		parameters: {
			type: Type.OBJECT,
			properties: {
				content: {
					type: Type.STRING,
					description: 'The full updated design document content in markdown.'
				}
			},
			required: ['content']
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

/** Extract text and function calls from a Gemini response. */
function parseResponse(response: GenerateContentResponse): { text: string; functionCalls: FunctionCall[] } {
	let text = '';
	const functionCalls: FunctionCall[] = [];

	if (response.candidates?.[0]?.content?.parts) {
		for (const part of response.candidates[0].content.parts) {
			if (part.text && !part.thought) {
				text += part.text;
			} else if (part.functionCall) {
				functionCalls.push(part.functionCall);
			}
		}
	}

	return { text, functionCalls };
}

// ── Text / orchestration messaging ──

/**
 * Send a message to the LLM for reasoning/orchestration.
 * Returns text, any function calls the model wants to make, and updated history.
 */
export async function sendMessage(
	apiKey: string,
	modelId: string,
	userParts: Part[],
	history: Content[] = [],
	config?: GenerateContentConfig
): Promise<ParsedTextResponse> {
	const client = getClient(apiKey);
	const chat: Chat = client.chats.create({
		model: modelId,
		history,
		config
	});

	const response = await chat.sendMessage({ message: userParts });
	const parsed = parseResponse(response);

	return {
		...parsed,
		history: chat.getHistory
			? await chat.getHistory()
			: [
					...history,
					{ role: 'user', parts: userParts },
					{ role: 'model', parts: response.candidates?.[0]?.content?.parts ?? [{ text: parsed.text }] }
				]
	};
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
