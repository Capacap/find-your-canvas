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
import type { MemoryTopic, StoredImage } from '$lib/types/schema';
import { sendMessage, generateImage, imageDataToBlob, blobToBase64, toolDeclarations } from './gemini';
import {
	systemTemplate,
	memoryIndexTemplate,
	memoryEmptyTemplate,
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
	| { type: 'memory_updated'; slug: string }
	| { type: 'error'; message: string }
	| { type: 'done'; assistantText: string; imageIds: string[] }
	| { type: 'debug_system_prompt'; prompt: string }
	| { type: 'debug_request'; round: number; parts: unknown[]; historyLength: number }
	| { type: 'debug_response'; round: number; text: string; functionCalls: unknown[] }
	| { type: 'debug_tool_exec'; name: string; args: Record<string, unknown> }
	| { type: 'debug_tool_result'; name: string; result: unknown };

export type EventCallback = (event: OrchestratorEvent) => void;

/** Maximum tool-call rounds before we force a stop. */
const MAX_TOOL_ROUNDS = 5;

// ── System prompt construction ──

/** Threshold below which all topic content is inlined instead of just the index. */
const INLINE_THRESHOLD = 4000;

function buildMemorySection(topics: MemoryTopic[]): string {
	if (topics.length === 0) return memoryEmptyTemplate;

	const totalContentLength = topics.reduce((sum, t) => sum + t.content.length, 0);

	if (totalContentLength <= INLINE_THRESHOLD) {
		// Small project: inline everything so the agent doesn't need read_memory.
		const sections = topics.map((t) =>
			`### ${t.title} (\`${t.slug}\`)\n${t.content}`
		);
		return '## Project Memory\n\n' + sections.join('\n\n');
	}

	// Larger project: show index only, agent uses read_memory for full content.
	const rows = topics.map((t) =>
		`| \`${t.slug}\` | ${t.title} | ${t.summary} |`
	).join('\n');
	return interpolate(memoryIndexTemplate, { rows });
}

function buildSystemPrompt(
	projectName: string,
	memoryTopics: MemoryTopic[],
	projectImages: StoredImage[]
): string {
	const memorySection = buildMemorySection(memoryTopics);

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
		memorySection,
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
		const refIds = (args.reference_image_ids as string[] | undefined) ?? [];

		onEvent({ type: 'image_generating', label });

		try {
			// Fetch reference images and convert to base64 for the image model.
			const inputImages: Array<{ data: string; mimeType: string }> = [];
			for (const refId of refIds) {
				const img = await ops.getImage(refId);
				if (img) {
					const data = await blobToBase64(img.blob);
					inputImages.push({ data, mimeType: img.mimeType });
				}
			}

			const imageResponse = await generateImage(apiKey, imageModel, prompt, {
				aspectRatio,
				inputImages: inputImages.length > 0 ? inputImages : undefined
			});
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

	if (name === 'read_memory') {
		const slug = args.topic as string;
		const topic = await ops.getMemoryTopicBySlug(projectId, slug);

		if (!topic) {
			const allTopics = await ops.listMemoryTopics(projectId);
			const available = allTopics.map((t) => t.slug).join(', ');
			const hint = available
				? `Topic "${slug}" not found. Available topics: ${available}`
				: `Topic "${slug}" not found. No topics exist yet. Use update_memory to create one.`;
			return {
				responseParts: [{ functionResponse: { name, response: { error: hint } } }]
			};
		}

		return {
			responseParts: [
				{ functionResponse: { name, response: { slug: topic.slug, title: topic.title, content: topic.content } } }
			]
		};
	}

	if (name === 'update_memory') {
		const slug = args.topic as string;
		const title = args.title as string;
		const summary = args.summary as string;
		const content = args.content as string;

		await ops.upsertMemoryTopic(projectId, slug, title, summary, content);
		onEvent({ type: 'memory_updated', slug });

		const action = content.trim() ? 'updated' : 'deleted';
		return {
			responseParts: [
				{ functionResponse: { name, response: { output: `Memory topic "${slug}" ${action}.` } } }
			]
		};
	}

	if (name === 'update_design_doc') {
		// Deprecation shim: redirect to update_memory.
		const content = args.content as string;
		await ops.upsertMemoryTopic(
			projectId,
			'project-notes',
			'Project Notes',
			'General project decisions (migrated from design document).',
			content
		);
		onEvent({ type: 'memory_updated', slug: 'project-notes' });
		return {
			responseParts: [
				{ functionResponse: { name, response: {
					output: 'Design document saved as memory topic "project-notes". Use update_memory instead of update_design_doc going forward. Consider splitting into focused topics.'
				} } }
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

	const memoryTopics = await ops.listMemoryTopics(projectId);
	const projectImages = await ops.listProjectImages(projectId);

	const systemPrompt = buildSystemPrompt(project.name, memoryTopics, projectImages);
	onEvent({ type: 'debug_system_prompt', prompt: systemPrompt });

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

		// Summarize parts for debug (replace binary data with placeholders).
		const debugParts = currentUserParts.map((p) => {
			if ('inlineData' in p && p.inlineData) {
				return { inlineData: { mimeType: p.inlineData.mimeType, data: `[${Math.ceil((p.inlineData.data?.length ?? 0) / 1024)}KB base64]` } };
			}
			if ('functionResponse' in p && p.functionResponse) {
				return { functionResponse: p.functionResponse };
			}
			return p;
		});
		onEvent({ type: 'debug_request', round, parts: debugParts, historyLength: history.length });

		const response = await sendMessage(
			settings.geminiApiKey,
			settings.textModel,
			currentUserParts,
			history,
			config
		);

		history = response.history;

		onEvent({
			type: 'debug_response',
			round,
			text: response.text,
			functionCalls: response.functionCalls.map((fc) => ({ name: fc.name, args: fc.args }))
		});

		if (response.text) {
			allAssistantText += (allAssistantText ? '\n\n' : '') + response.text;
			onEvent({ type: 'text', text: response.text });
		}

		// No function calls means the agent is done.
		if (response.functionCalls.length === 0) break;

		// Execute function calls and collect response parts.
		const allResponseParts: Part[] = [];

		for (const call of response.functionCalls) {
			const callArgs = (call.args ?? {}) as Record<string, unknown>;
			onEvent({ type: 'debug_tool_exec', name: call.name ?? 'unknown', args: callArgs });

			const { responseParts, imageId } = await executeToolCall(
				call,
				projectId,
				settings.geminiApiKey,
				settings.imageModel,
				onEvent
			);

			// Summarize tool result for debug (strip binary).
			const debugResult = responseParts.map((p) => {
				if ('inlineData' in p && p.inlineData) {
					return { inlineData: { mimeType: p.inlineData.mimeType, data: '[thumbnail]' } };
				}
				if ('functionResponse' in p && p.functionResponse) {
					return { functionResponse: p.functionResponse };
				}
				return p;
			});
			onEvent({ type: 'debug_tool_result', name: call.name ?? 'unknown', result: debugResult });

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
