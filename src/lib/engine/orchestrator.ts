/**
 * The orchestration engine. This is the core portfolio piece.
 *
 * Manages the agent turn loop:
 * 1. Build system prompt with project context
 * 2. Send user message to the LLM with native function declarations
 * 3. If the model returns function calls, execute them
 * 4. Feed function results back and repeat if needed
 * 5. Return final response for the caller to persist
 *
 * The engine has no direct database dependencies. All state is provided
 * via TurnContext, and all side effects go through TurnActions.
 */
import { ThinkingLevel, type Content, type FunctionCall, type Part } from '@google/genai';
import type { Message, MemoryTopic, StoredImage, ImageSource } from '$lib/types/schema';
import { sendMessageStreaming, generateImage, imageDataToBlob, blobToBase64, toolDeclarations } from './gemini';
import {
	systemTemplate,
	memoryIndexTemplate,
	memoryEmptyTemplate,
	interpolate
} from './prompts';

/** What the orchestrator emits to the UI as it works. */
export type OrchestratorEvent =
	| { type: 'text_delta'; text: string }
	| { type: 'thought_delta'; text: string }
	| { type: 'status'; text: string }
	| { type: 'image_generating'; label: string }
	| { type: 'image_complete'; imageId: string; label: string }
	| { type: 'image_viewing'; imageId: string; reason?: string }
	| { type: 'memory_updated'; slug: string }
	| { type: 'error'; message: string }
	| { type: 'done'; assistantText: string; imageIds: string[] }
	| { type: 'debug_system_prompt'; prompt: string }
	| { type: 'debug_request'; round: number; parts: unknown[]; historyLength: number }
	| { type: 'debug_response'; round: number; text: string; functionCalls: unknown[] }
	| { type: 'debug_tool_exec'; name: string; args: Record<string, unknown> }
	| { type: 'debug_tool_result'; name: string; result: unknown };

export type EventCallback = (event: OrchestratorEvent) => void;

/** Pre-fetched context for an agent turn. */
export interface TurnContext {
	apiKey: string;
	textModel: string;
	imageModel: string;
	projectName: string;
	memoryTopics: MemoryTopic[];
	projectImages: StoredImage[];
	messages: Message[];
}

/** Side effects the orchestrator can perform during tool execution. */
export interface TurnActions {
	storeImage(blob: Blob, label: string, opts?: { source?: ImageSource; generationContext?: string }): Promise<StoredImage>;
	getImage(id: string): Promise<StoredImage | undefined>;
	getImageThumbnail(id: string): Promise<{ base64: string; mimeType: string } | undefined>;
	getMemoryTopicBySlug(slug: string): Promise<MemoryTopic | undefined>;
	listMemoryTopics(): Promise<MemoryTopic[]>;
	upsertMemoryTopic(slug: string, title: string, summary: string, content: string): Promise<void>;
}

/** What the caller needs to persist after a turn completes. */
export interface TurnResult {
	userText: string;
	userImageIds: string[];
	assistantText: string;
	assistantImageIds: string[];
}

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

// ── History conversion ──

/** Convert stored messages to Gemini Content[] for the API. */
function buildHistory(messages: Message[]): Content[] {
	return messages.map((m) => ({
		role: m.role === 'assistant' ? 'model' : 'user',
		parts: [{ text: m.text }]
	}));
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
	ctx: TurnContext,
	actions: TurnActions,
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
				const img = await actions.getImage(refId);
				if (img) {
					const data = await blobToBase64(img.blob);
					inputImages.push({ data, mimeType: img.mimeType });
				}
			}

			const imageResponse = await generateImage(ctx.apiKey, ctx.imageModel, prompt, {
				aspectRatio,
				inputImages: inputImages.length > 0 ? inputImages : undefined
			});
			const blob = imageDataToBlob(imageResponse.imageData, imageResponse.mimeType);
			const stored = await actions.storeImage(blob, label, { generationContext: prompt });

			onEvent({ type: 'image_complete', imageId: stored.id, label });

			// Return the thumbnail so the model can see what was generated.
			const thumb = await actions.getImageThumbnail(stored.id);
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

		try {
			const thumb = await actions.getImageThumbnail(imageId);
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			onEvent({ type: 'error', message: `Failed to view image: ${msg}` });
			return {
				responseParts: [{ functionResponse: { name, response: { error: msg } } }]
			};
		}
	}

	if (name === 'read_memory') {
		const slug = args.topic as string;

		try {
			const topic = await actions.getMemoryTopicBySlug(slug);

			if (!topic) {
				const allTopics = await actions.listMemoryTopics();
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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			onEvent({ type: 'error', message: `Failed to read memory: ${msg}` });
			return {
				responseParts: [{ functionResponse: { name, response: { error: msg } } }]
			};
		}
	}

	if (name === 'update_memory') {
		const slug = args.topic as string;
		const title = args.title as string;
		const summary = args.summary as string;
		const content = args.content as string;

		try {
			await actions.upsertMemoryTopic(slug, title, summary, content);
			onEvent({ type: 'memory_updated', slug });

			const action = content.trim() ? 'updated' : 'deleted';
			return {
				responseParts: [
					{ functionResponse: { name, response: { output: `Memory topic "${slug}" ${action}.` } } }
				]
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			onEvent({ type: 'error', message: `Failed to update memory: ${msg}` });
			return {
				responseParts: [{ functionResponse: { name, response: { error: msg } } }]
			};
		}
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
	ctx: TurnContext,
	actions: TurnActions,
	userText: string,
	onEvent: EventCallback,
	attachments: UserAttachment[] = []
): Promise<TurnResult> {
	const emptyResult: TurnResult = { userText: '', userImageIds: [], assistantText: '', assistantImageIds: [] };

	if (!ctx.apiKey) {
		onEvent({ type: 'error', message: 'No API key configured. Add your Gemini API key in settings.' });
		return emptyResult;
	}

	const systemPrompt = buildSystemPrompt(ctx.projectName, ctx.memoryTopics, ctx.projectImages);
	onEvent({ type: 'debug_system_prompt', prompt: systemPrompt });

	const config = {
		systemInstruction: systemPrompt,
		tools: [{ functionDeclarations: toolDeclarations }],
		thinkingConfig: { includeThoughts: true, thinkingLevel: ThinkingLevel.LOW }
	};

	// Store and encode user-attached images.
	const userImageIds: string[] = [];
	const userImageParts: Part[] = [];
	for (const attachment of attachments) {
		const stored = await actions.storeImage(attachment.blob, attachment.label, { source: 'user' });
		userImageIds.push(stored.id);
		const base64 = await blobToBase64(attachment.blob);
		userImageParts.push({
			inlineData: { data: base64, mimeType: attachment.blob.type || 'image/png' }
		});
	}

	let history = buildHistory(ctx.messages);
	let currentUserParts: Part[] = [{ text: userText }, ...userImageParts];
	let allAssistantText = '';
	let allImageIds: string[] = [];

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		onEvent({ type: 'status', text: round === 0 ? 'Thinking...' : 'Processing tool results...' });

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

		const { stream, getResult } = await sendMessageStreaming(
			ctx.apiKey,
			ctx.textModel,
			currentUserParts,
			history,
			config
		);

		let roundText = '';
		const roundFunctionCalls: { name: string; args: unknown }[] = [];

		for await (const chunk of stream) {
			if (chunk.textDelta) {
				roundText += chunk.textDelta;
				onEvent({ type: 'text_delta', text: chunk.textDelta });
			}
			if (chunk.thoughtDelta) {
				onEvent({ type: 'thought_delta', text: chunk.thoughtDelta });
			}
			if (chunk.functionCalls) {
				for (const fc of chunk.functionCalls) {
					roundFunctionCalls.push({ name: fc.name ?? 'unknown', args: fc.args });
				}
			}
		}

		const result = await getResult();
		history = result.history;

		onEvent({
			type: 'debug_response',
			round,
			text: result.text,
			functionCalls: roundFunctionCalls
		});

		if (roundText) {
			allAssistantText += (allAssistantText ? '\n\n' : '') + roundText;
		}

		// No function calls means the agent is done.
		if (result.functionCalls.length === 0) break;

		// Execute function calls and collect response parts.
		const allResponseParts: Part[] = [];

		for (const call of result.functionCalls) {
			const callArgs = (call.args ?? {}) as Record<string, unknown>;
			onEvent({ type: 'debug_tool_exec', name: call.name ?? 'unknown', args: callArgs });

			const { responseParts, imageId } = await executeToolCall(
				call,
				ctx,
				actions,
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

		if (round === MAX_TOOL_ROUNDS - 1) {
			onEvent({ type: 'error', message: `Agent stopped after ${MAX_TOOL_ROUNDS} tool rounds. Some pending tool calls were not executed.` });
		}
	}

	// Build the final texts with image references for the caller to persist.
	const userImageRefs = userImageIds.map((id) => `[image:${id}]`).join(' ');
	const finalUserText = userImageRefs ? `${userText}\n\n${userImageRefs}` : userText;

	const imageRefs = allImageIds.map((id) => `[image:${id}]`).join(' ');
	const finalAssistantText = imageRefs ? `${allAssistantText}\n\n${imageRefs}` : allAssistantText;

	onEvent({ type: 'done', assistantText: finalAssistantText, imageIds: allImageIds });

	return {
		userText: finalUserText,
		userImageIds,
		assistantText: finalAssistantText,
		assistantImageIds: allImageIds
	};
}
