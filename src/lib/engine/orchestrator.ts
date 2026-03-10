/**
 * The orchestration engine. This is the core portfolio piece.
 *
 * Manages the agent turn loop:
 * 1. Build system prompt with project context
 * 2. Send user message to the LLM with native function declarations
 * 3. If the model returns function calls, execute them
 * 4. Feed function results back and repeat if needed
 * 5. Yield final response to the UI
 */
import type { Content, FunctionCall, Part } from '@google/genai';
import type { DesignDocument, StoredImage } from '$lib/types/schema';
import { sendMessage, generateImage, imageDataToBlob, blobToBase64, toolDeclarations } from './gemini';
import {
	systemTemplate,
	designDocFullTemplate,
	designDocEmptyTemplate,
	interpolate
} from './prompts';
import { getSettings, getImageThumbnailBase64 } from '$lib/db/operations';
import * as ops from '$lib/db/operations';

/** What the orchestrator emits to the UI as it works. */
export type OrchestratorEvent =
	| { type: 'thinking'; text: string }
	| { type: 'text'; text: string }
	| { type: 'image_generating'; label: string }
	| { type: 'image_complete'; imageId: string; label: string }
	| { type: 'image_viewing'; imageId: string; reason?: string }
	| { type: 'design_doc_updated' }
	| { type: 'error'; message: string }
	| { type: 'done'; assistantText: string; imageIds: string[] };

export type EventCallback = (event: OrchestratorEvent) => void;

/** Maximum tool-call rounds before we force a stop. */
const MAX_TOOL_ROUNDS = 5;

// ── System prompt construction ──

function buildSystemPrompt(
	projectName: string,
	designDoc: DesignDocument | undefined,
	projectImages: StoredImage[]
): string {
	const designDocSection =
		designDoc?.content
			? interpolate(designDocFullTemplate, { content: designDoc.content })
			: designDocEmptyTemplate;

	let imageIndexSection = '';
	if (projectImages.length > 0) {
		const userImages = projectImages.filter((img) => img.source === 'user');
		const generatedImages = projectImages.filter((img) => img.source !== 'user');
		const lines: string[] = [];

		if (userImages.length > 0) {
			lines.push('## Reference Images (uploaded by user)');
			lines.push('Use view_image to examine reference material the user has provided.', '');
			for (const img of userImages) {
				lines.push(`- **${img.label}** (id: ${img.id})`);
			}
			lines.push('');
		}

		if (generatedImages.length > 0) {
			lines.push('## Generated Images');
			lines.push('Use view_image to review previous generations.', '');
			for (const img of generatedImages) {
				const desc = img.generationContext
					? ` — ${img.generationContext.slice(0, 120)}${img.generationContext.length > 120 ? '...' : ''}`
					: '';
				lines.push(`- **${img.label}** (id: ${img.id})${desc}`);
			}
		}

		imageIndexSection = lines.join('\n');
	}

	return interpolate(systemTemplate, {
		projectName,
		designDocSection,
		imageIndexSection
	});
}

// ── Tool execution ──

interface ToolExecResult {
	/** Parts to send back as the function response. */
	responseParts: Part[];
	/** If this tool call produced a new image, its ID. */
	imageId?: string;
}

async function executeToolCall(
	call: FunctionCall,
	projectId: string,
	apiKey: string,
	imageModel: string,
	onEvent: EventCallback
): Promise<ToolExecResult> {
	const args = call.args ?? {};
	const name = call.name ?? 'unknown';

	if (name === 'generate_image') {
		const label = (args.label as string) || 'generated_image';
		const prompt = args.prompt as string;
		const aspectRatio = args.aspect_ratio as string | undefined;

		onEvent({ type: 'image_generating', label });

		try {
			const imageResponse = await generateImage(apiKey, imageModel, prompt, { aspectRatio });
			const blob = imageDataToBlob(imageResponse.imageData, imageResponse.mimeType);
			const stored = await ops.storeImage(projectId, blob, label, {
				generationContext: prompt
			});

			onEvent({ type: 'image_complete', imageId: stored.id, label });

			// Return the thumbnail so the model can see what was generated.
			const thumb = await getImageThumbnailBase64(stored.id);
			const parts: Part[] = [
				{
					functionResponse: {
						name,
						response: { output: `Image generated: [image:${stored.id}] "${label}"` }
					}
				}
			];
			if (thumb) {
				parts.push({ inlineData: { data: thumb.base64, mimeType: thumb.mimeType } });
			}
			return { responseParts: parts, imageId: stored.id };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			onEvent({ type: 'error', message: `Image generation failed: ${msg}` });
			return {
				responseParts: [{ functionResponse: { name, response: { error: msg } } }]
			};
		}
	}

	if (name === 'view_image') {
		const imageId = args.image_id as string;
		const reason = args.reason as string | undefined;

		onEvent({ type: 'image_viewing', imageId, reason });

		const thumb = await getImageThumbnailBase64(imageId);
		if (!thumb) {
			return {
				responseParts: [
					{ functionResponse: { name, response: { error: `Image not found: ${imageId}` } } }
				]
			};
		}

		return {
			responseParts: [
				{ functionResponse: { name, response: { output: `Showing image ${imageId}` } } },
				{ inlineData: { data: thumb.base64, mimeType: thumb.mimeType } }
			]
		};
	}

	if (name === 'update_design_doc') {
		const content = args.content as string;
		await ops.updateDesignDocument(projectId, content);
		onEvent({ type: 'design_doc_updated' });
		return {
			responseParts: [
				{ functionResponse: { name, response: { output: 'Design document updated successfully.' } } }
			]
		};
	}

	return {
		responseParts: [
			{ functionResponse: { name, response: { error: `Unknown tool: ${name}` } } }
		]
	};
}

// ── Main orchestration loop ──

export interface UserAttachment {
	blob: Blob;
	label: string;
}

export async function runAgentTurn(
	projectId: string,
	conversationId: string,
	userText: string,
	conversationHistory: Content[],
	onEvent: EventCallback,
	attachments: UserAttachment[] = []
): Promise<void> {
	const settings = await getSettings();
	if (!settings.geminiApiKey) {
		onEvent({ type: 'error', message: 'No API key configured. Add your Gemini API key in settings.' });
		return;
	}

	const project = await ops.getProject(projectId);
	if (!project) {
		onEvent({ type: 'error', message: 'Project not found.' });
		return;
	}

	const designDoc = await ops.getDesignDocument(projectId);
	const projectImages = await ops.listProjectImages(projectId);

	const systemPrompt = buildSystemPrompt(project.name, designDoc, projectImages);

	const config = {
		systemInstruction: systemPrompt,
		tools: [{ functionDeclarations: toolDeclarations }]
	};

	// Store and encode user-attached images.
	const userImageIds: string[] = [];
	const userImageParts: Part[] = [];
	for (const attachment of attachments) {
		const stored = await ops.storeImage(projectId, attachment.blob, attachment.label, { source: 'user' });
		userImageIds.push(stored.id);
		const base64 = await blobToBase64(attachment.blob);
		userImageParts.push({
			inlineData: { data: base64, mimeType: attachment.blob.type || 'image/png' }
		});
	}

	let history = [...conversationHistory];
	let currentUserParts: Part[] = [{ text: userText }, ...userImageParts];
	let allAssistantText = '';
	let allImageIds: string[] = [];

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		onEvent({ type: 'thinking', text: round === 0 ? 'Thinking...' : 'Processing tool results...' });

		const response = await sendMessage(
			settings.geminiApiKey,
			settings.textModel,
			currentUserParts,
			history,
			config
		);

		history = response.history;

		if (response.text) {
			allAssistantText += (allAssistantText ? '\n\n' : '') + response.text;
			onEvent({ type: 'text', text: response.text });
		}

		// No function calls means the agent is done.
		if (response.functionCalls.length === 0) break;

		// Execute function calls and collect response parts.
		const allResponseParts: Part[] = [];

		for (const call of response.functionCalls) {
			const { responseParts, imageId } = await executeToolCall(
				call,
				projectId,
				settings.geminiApiKey,
				settings.imageModel,
				onEvent
			);
			if (imageId) allImageIds.push(imageId);
			allResponseParts.push(...responseParts);
		}

		// Feed function results (and any inline images) back as the next message.
		currentUserParts = allResponseParts;
	}

	// Store user message with any attached image refs.
	const userImageRefs = userImageIds.map((id) => `[image:${id}]`).join(' ');
	const userFullText = userImageRefs ? `${userText}\n\n${userImageRefs}` : userText;
	await ops.addMessage(conversationId, 'user', userFullText, userImageIds);

	// Store the final assistant message.
	const imageRefs = allImageIds.map((id) => `[image:${id}]`).join(' ');
	const fullText = imageRefs ? `${allAssistantText}\n\n${imageRefs}` : allAssistantText;
	await ops.addMessage(conversationId, 'assistant', fullText, allImageIds);

	onEvent({ type: 'done', assistantText: fullText, imageIds: allImageIds });
}
