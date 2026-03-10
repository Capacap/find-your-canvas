/**
 * Gemini API client wrapper.
 *
 * Rules (from claude_banana experience):
 * - Always use chats.create() + chat.sendMessage(), never models.generateContent()
 * - Don't set responseModalities; image models return images by default
 * - Input MIME types: png, jpeg, webp, heic, heif (no gif)
 */
import { GoogleGenAI, type Chat, type Content, type GenerateContentConfig, type Part } from '@google/genai';

export interface GeminiTextResponse {
	text: string;
	history: Content[];
}

export interface GeminiImageResponse {
	text: string;
	imageData: Uint8Array;
	mimeType: string;
	history: Content[];
}

let clientInstance: GoogleGenAI | null = null;
let currentApiKey: string | null = null;

function getClient(apiKey: string): GoogleGenAI {
	if (clientInstance && currentApiKey === apiKey) return clientInstance;
	clientInstance = new GoogleGenAI({ apiKey });
	currentApiKey = apiKey;
	return clientInstance;
}

/**
 * Send a text message to the LLM for reasoning/orchestration.
 * Returns the text response and updated conversation history.
 */
export async function sendTextMessage(
	apiKey: string,
	modelId: string,
	userParts: Part[],
	history: Content[] = [],
	config?: GenerateContentConfig
): Promise<GeminiTextResponse> {
	const client = getClient(apiKey);
	const chat: Chat = client.chats.create({
		model: modelId,
		history,
		config
	});

	const response = await chat.sendMessage({ message: userParts });

	let text = '';
	if (response.candidates?.[0]?.content?.parts) {
		for (const part of response.candidates[0].content.parts) {
			if (part.text && !part.thought) {
				text += part.text;
			}
		}
	}

	return {
		text,
		history: chat.getHistory ? await chat.getHistory() : [
			...history,
			{ role: 'user', parts: userParts },
			{ role: 'model', parts: [{ text }] }
		]
	};
}

/**
 * Generate an image using a Gemini image model.
 * Returns the image data, any text commentary, and updated history.
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
		history: chat.getHistory ? await chat.getHistory() : [
			...( options.history ?? []),
			{ role: 'user', parts },
			{ role: 'model', parts: response.candidates?.[0]?.content?.parts ?? [] }
		]
	};
}

/**
 * Convert a Blob to a base64 string suitable for the Gemini API.
 */
export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			// Strip the data URL prefix (data:image/png;base64,)
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
