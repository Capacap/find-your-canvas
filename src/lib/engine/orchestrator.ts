/**
 * The orchestration engine. This is the core portfolio piece.
 *
 * Manages the agent turn loop:
 * 1. Build system prompt with project context
 * 2. Send user message to the LLM
 * 3. Parse the response for tool calls
 * 4. Execute tools (image generation, design doc updates)
 * 5. Feed results back and repeat if needed
 * 6. Yield final response to the UI
 */
import type { Content, Part } from '@google/genai';
import type { DesignDocument, StoredImage } from '$lib/types/schema';
import { sendTextMessage, generateImage, imageDataToBlob, blobToBase64 } from './gemini';
import { getSettings } from '$lib/db/operations';
import * as ops from '$lib/db/operations';

/** What the orchestrator emits to the UI as it works. */
export type OrchestratorEvent =
	| { type: 'thinking'; text: string }
	| { type: 'text'; text: string }
	| { type: 'image_generating'; label: string }
	| { type: 'image_complete'; imageId: string; label: string }
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
	recentImages: StoredImage[]
): string {
	const parts: string[] = [];

	parts.push(`You are a creative assistant working on a project called "${projectName}".`);
	parts.push('You help the user develop visual concepts, maintain creative continuity, and generate images that fit within the established project context.');
	parts.push('');

	if (designDoc?.content) {
		parts.push('## Design Document (established decisions)');
		parts.push(designDoc.content);
		parts.push('');
	} else {
		parts.push('## Design Document');
		parts.push('No decisions established yet. As we work together, I will build a design document capturing key decisions about style, characters, settings, and other elements.');
		parts.push('');
	}

	if (recentImages.length > 0) {
		parts.push('## Recent Images');
		for (const img of recentImages.slice(-10)) {
			const ctx = img.generationContext ? ` (context: ${img.generationContext})` : '';
			parts.push(`- [image:${img.id}] "${img.label}"${ctx}`);
		}
		parts.push('');
	}

	parts.push('## Tools');
	parts.push('You have access to the following tools. Use them by responding with a JSON tool call block:');
	parts.push('');
	parts.push('### generate_image');
	parts.push('Generate concept art. Provide a detailed prompt and a short label.');
	parts.push('```json');
	parts.push('{"tool": "generate_image", "prompt": "detailed image prompt...", "label": "short_label", "aspect_ratio": "16:9"}');
	parts.push('```');
	parts.push('Supported aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9');
	parts.push('');
	parts.push('### update_design_doc');
	parts.push('Update the design document with new decisions. Provide the full updated content.');
	parts.push('```json');
	parts.push('{"tool": "update_design_doc", "content": "full updated design document..."}');
	parts.push('```');
	parts.push('');
	parts.push('## Guidelines');
	parts.push('- Reference existing images by their ID when discussing them: [image:id]');
	parts.push('- When generating images, write prompts that incorporate established project context.');
	parts.push('- Update the design document when new creative decisions are made.');
	parts.push('- Think about continuity: characters should look consistent, settings should match.');
	parts.push('- You can generate multiple images and update the design doc in one response.');
	parts.push('- Explain your creative reasoning. The user wants to understand your thinking.');

	return parts.join('\n');
}

// ── Tool parsing ──

interface ToolCall {
	tool: string;
	[key: string]: unknown;
}

/**
 * Extract tool call JSON blocks from the model's response text.
 * Looks for ```json blocks containing a "tool" field.
 */
function extractToolCalls(text: string): { cleanText: string; toolCalls: ToolCall[] } {
	const toolCalls: ToolCall[] = [];
	const jsonBlockPattern = /```json\s*\n([\s\S]*?)\n```/g;

	const cleanText = text.replace(jsonBlockPattern, (_, jsonStr) => {
		try {
			const parsed = JSON.parse(jsonStr.trim());
			if (parsed && typeof parsed.tool === 'string') {
				toolCalls.push(parsed as ToolCall);
				return ''; // Remove tool call block from visible text
			}
		} catch {
			// Not valid JSON or not a tool call; leave it in the text.
		}
		return _;
	}).trim();

	return { cleanText, toolCalls };
}

// ── Main orchestration loop ──

export async function runAgentTurn(
	projectId: string,
	conversationId: string,
	userText: string,
	conversationHistory: Content[],
	onEvent: EventCallback
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

	let history = [...conversationHistory];
	let currentUserParts: Part[] = [{ text: userText }];
	let allAssistantText = '';
	let allImageIds: string[] = [];

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		onEvent({ type: 'thinking', text: round === 0 ? 'Thinking...' : 'Processing tool results...' });

		const config = {
			systemInstruction: systemPrompt
		};

		const response = await sendTextMessage(
			settings.geminiApiKey,
			settings.textModel,
			currentUserParts,
			history,
			config
		);

		history = response.history;

		const { cleanText, toolCalls } = extractToolCalls(response.text);

		if (cleanText) {
			allAssistantText += (allAssistantText ? '\n\n' : '') + cleanText;
			onEvent({ type: 'text', text: cleanText });
		}

		// No tool calls means the agent is done.
		if (toolCalls.length === 0) break;

		// Execute tool calls.
		const toolResults: string[] = [];

		for (const call of toolCalls) {
			if (call.tool === 'generate_image') {
				const label = (call.label as string) || 'generated_image';
				const prompt = call.prompt as string;
				const aspectRatio = call.aspect_ratio as string | undefined;

				onEvent({ type: 'image_generating', label });

				try {
					const imageResponse = await generateImage(
						settings.geminiApiKey,
						settings.imageModel,
						prompt,
						{ aspectRatio }
					);

					const blob = imageDataToBlob(imageResponse.imageData, imageResponse.mimeType);
					const stored = await ops.storeImage(projectId, blob, label, {
						generationContext: prompt
					});

					allImageIds.push(stored.id);
					onEvent({ type: 'image_complete', imageId: stored.id, label });
					toolResults.push(`Image generated successfully: [image:${stored.id}] "${label}"`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					toolResults.push(`Image generation failed: ${msg}`);
					onEvent({ type: 'error', message: `Image generation failed: ${msg}` });
				}
			} else if (call.tool === 'update_design_doc') {
				const content = call.content as string;
				await ops.updateDesignDocument(projectId, content);
				onEvent({ type: 'design_doc_updated' });
				toolResults.push('Design document updated successfully.');
			} else {
				toolResults.push(`Unknown tool: ${call.tool}`);
			}
		}

		// Feed tool results back as the next user message for the loop.
		currentUserParts = [{ text: 'Tool results:\n' + toolResults.join('\n') }];
	}

	// Store the final assistant message.
	const imageRefs = allImageIds.map((id) => `[image:${id}]`).join(' ');
	const fullText = imageRefs ? `${allAssistantText}\n\n${imageRefs}` : allAssistantText;

	await ops.addMessage(conversationId, 'user', userText);
	await ops.addMessage(conversationId, 'assistant', fullText, allImageIds);

	onEvent({ type: 'done', assistantText: fullText, imageIds: allImageIds });
}
