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
import { Type, ThinkingLevel, type Content, type FunctionCall, type FunctionDeclaration, type Part } from '@google/genai';
import type { AgentMemory, ImageMeta, ImageBlob, ImageSource } from '$lib/types/schema';
import { sendMessageStreaming, generateImage } from './gemini';
import { blobToBase64, base64ToBlob } from '$lib/utils';
import {
  systemTemplate,
  memoryIndexTemplate,
  memoryEmptyTemplate,
  interpolate
} from './prompts';

// ── Exported types ──

/** What the orchestrator emits to the UI as it works. */
export type OrchestratorEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'image_generating'; label: string }
  | { type: 'image_complete'; imageId: string; label: string }
  | { type: 'image_viewing'; imageIds: string[]; reason?: string }
  | { type: 'memory_updated'; slug: string }
  | { type: 'error'; message: string }
  | { type: 'done'; assistantText: string; imageIds: string[] }
  | { type: 'debug_system_prompt'; prompt: string }
  | { type: 'debug_request'; round: number; parts: unknown[]; historyLength: number }
  | { type: 'debug_response'; round: number; text: string; functionCalls: unknown[] }
  | { type: 'debug_tool_exec'; name: string; args: Record<string, unknown> }
  | { type: 'debug_tool_result'; name: string; result: unknown }
  | { type: 'debug_thought'; round: number; text: string }
  | { type: 'debug_turn_boundary'; timestamp: number };

export type EventCallback = (event: OrchestratorEvent) => void;

/** Pre-fetched context for an agent turn. */
export interface TurnContext {
  apiKey: string;
  textModel: string;
  imageModel: string;
  projectName: string;
  agentMemories: AgentMemory[];
  projectImages: ImageMeta[];
  /** Raw Gemini history from the conversation, passed directly to the API. */
  apiHistory: Content[];
  /** Signal to abort the turn. Checked between rounds and passed to API calls. */
  signal?: AbortSignal;
}

/** Side effects the orchestrator can perform during tool execution. */
export interface TurnActions {
  createImage(blob: Blob, label: string, opts?: { source?: ImageSource; generationContext?: string }): Promise<ImageMeta>;
  getImage(id: string): Promise<(ImageMeta & ImageBlob) | undefined>;
  getImageThumbnail(id: string): Promise<{ base64: string; mimeType: string } | undefined>;
  getAgentMemory(slug: string): Promise<AgentMemory | undefined>;
  listAgentMemories(): Promise<AgentMemory[]>;
  upsertAgentMemory(slug: string, title: string, summary: string, content: string): Promise<void>;
}

/** What the caller needs to persist after a turn completes. */
export interface TurnResult {
  userText: string;
  userImageIds: string[];
  assistantText: string;
  assistantImageIds: string[];
  /** Updated Gemini history including this turn, for storage on the conversation. */
  apiHistory: Content[];
  /** If set, the turn ended due to an error. Partial results above should still be persisted. */
  error?: string;
}

export interface UserAttachment {
  blob: Blob;
  label: string;
}

// ── Constants ──

/** Maximum tool-call rounds before we force a stop. */
const MAX_TOOL_ROUNDS = 10;

/**
 * Maximum function calls to execute per round. Gemini 3 models have a
 * server-side bug (Google issue #1275) where 3+ parallel function calls
 * in a single response can produce missing thoughtSignature parts, which
 * corrupts the curated history and causes 400 errors on subsequent turns.
 * Capping at 2 avoids the bug; excess calls get an error response asking
 * the model to retry them in the next round.
 */
const MAX_PARALLEL_CALLS = 2;

/**
 * Debug fault injection. When set to a round number (0-indexed), the
 * orchestrator throws a simulated error at the start of that round.
 * Resets to null after firing.
 */
let _debugFaultRound: number | null = null;

export function debugInjectFault(round: number): void {
  if (!import.meta.env.DEV) return;
  _debugFaultRound = round;
}

// ── System prompt construction ──

function buildMemorySection(topics: AgentMemory[]): string {
  if (topics.length === 0) return memoryEmptyTemplate;

  const rows = topics.map((t) =>
    `| \`${t.slug}\` | ${t.title} | ${t.summary} |`
  ).join('\n');
  return interpolate(memoryIndexTemplate, { rows });
}

function buildImageIndex(images: ImageMeta[]): string {
  if (images.length === 0) return '';

  const userImages = images.filter((img) => img.source === 'user');
  const generatedImages = images.filter((img) => img.source !== 'user');
  const lines: string[] = [];

  if (userImages.length > 0) {
    lines.push('## Reference Images (uploaded by user)');
    lines.push('Use view_images to examine reference material the user has provided.', '');
    for (const img of userImages) {
      lines.push(`- **${img.label}** (id: ${img.id})`);
    }
    lines.push('');
  }

  if (generatedImages.length > 0) {
    lines.push('## Generated Images');
    lines.push('Use view_images to review previous generations.', '');
    for (const img of generatedImages) {
      const genCtx = img.generationContext;
      const desc = genCtx
        ? ` — ${genCtx.slice(0, 120)}${genCtx.length > 120 ? '...' : ''}`
        : '';
      lines.push(`- **${img.label}** (id: ${img.id})${desc}`);
    }
  }

  return lines.join('\n');
}

export function buildSystemPrompt(
  projectName: string,
  agentMemories: AgentMemory[],
  projectImages: ImageMeta[]
): string {
  return interpolate(systemTemplate, {
    projectName,
    memorySection: buildMemorySection(agentMemories),
    imageIndexSection: buildImageIndex(projectImages)
  });
}

// ── Helpers ──

/** Replace a base64 string with a size placeholder. */
function redactBase64(data: string, mimeType?: string): string {
  const kb = Math.ceil((data.length * 3) / 4 / 1024);
  return `[${kb}KB ${mimeType ?? 'binary'}]`;
}

/** Replace binary data with size placeholders for debug logging. */
function redactParts(parts: Part[]): unknown[] {
  return parts.map((p) => {
    if ('inlineData' in p && p.inlineData) {
      return { inlineData: { mimeType: p.inlineData.mimeType, data: redactBase64(p.inlineData.data ?? '', p.inlineData.mimeType) } };
    }
    if ('functionResponse' in p && p.functionResponse) {
      const fr = p.functionResponse as Record<string, unknown>;
      const redacted: Record<string, unknown> = { name: p.functionResponse.name, id: p.functionResponse.id, response: p.functionResponse.response };
      if (Array.isArray(fr.parts)) {
        redacted.parts = redactParts(fr.parts as Part[]);
      }
      return { functionResponse: redacted };
    }
    return p;
  });
}

/** Store attachments and encode them as inline data parts for the API. */
async function processAttachments(
  attachments: UserAttachment[],
  actions: TurnActions
): Promise<{ ids: string[]; parts: Part[] }> {
  const results = await Promise.all(
    attachments.map(async (attachment) => {
      const [stored, base64] = await Promise.all([
        actions.createImage(attachment.blob, attachment.label, { source: 'user' }),
        blobToBase64(attachment.blob)
      ]);
      return {
        id: stored.id,
        part: { inlineData: { data: base64, mimeType: attachment.blob.type || 'image/png' } } as Part
      };
    })
  );
  return { ids: results.map((r) => r.id), parts: results.map((r) => r.part) };
}

/** Append image references like [image:id] to text, if any. */
function appendImageRefs(text: string, imageIds: string[]): string {
  if (imageIds.length === 0) return text;
  const refs = imageIds.map((id) => `[image:${id}]`).join(' ');
  return `${text}\n\n${refs}`;
}

// ── Tool declarations ──

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
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
    name: 'view_images',
    description:
      'View one or more project images by ID. Returns the images so you can see their contents. Use this when you need to reference, compare, or iterate on previous images. Batch multiple IDs into a single call rather than calling separately.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        image_ids: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'IDs of the images to view (from the project images index). Max 6.'
        },
        reason: {
          type: Type.STRING,
          description: 'Brief note on why you need to see these images (helps the user follow your thinking).'
        }
      },
      required: ['image_ids']
    }
  },
  {
    name: 'read_memory',
    description:
      'Read the full content of a project memory topic by its slug. Use this to recall established decisions before making changes.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        slug: {
          type: Type.STRING,
          description: 'The slug of the memory topic to read (from the memory index in the system prompt).'
        }
      },
      required: ['slug']
    }
  },
  {
    name: 'update_memory',
    description:
      'Create, update, or delete a project memory topic. All fields are required on every call to keep the index coherent. To delete a topic, pass empty content.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        slug: {
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
      required: ['slug', 'title', 'summary', 'content']
    }
  }
];

// ── Tool execution ──

interface ToolExecResult {
  /** Parts to send back as the function response. */
  responseParts: Part[];
  /** If this tool call produced a new image, its ID. */
  imageId?: string;
}

type ToolArgs = Record<string, unknown>;

/** Build a functionResponse part, preserving the call id for round-tripping.
 *  Gemini 3 supports nested `parts` on functionResponse for multimodal content
 *  (e.g. images). This avoids the junk-text bug caused by sibling inlineData parts. */
function functionResponsePart(
  toolName: string,
  callId: string | undefined,
  response: Record<string, unknown>,
  nestedParts?: Part[]
): Part {
  const fr: Part = { functionResponse: { name: toolName, id: callId, response } };
  if (nestedParts && nestedParts.length > 0) {
    (fr.functionResponse as Record<string, unknown>).parts = nestedParts;
  }
  return fr;
}

/** Build a ToolExecResult for an error, emitting an event. */
function toolErrorResult(toolName: string, callId: string | undefined, err: unknown, label: string, onEvent: EventCallback): ToolExecResult {
  const msg = err instanceof Error ? err.message : String(err);
  onEvent({ type: 'error', message: `${label}: ${msg}` });
  return { responseParts: [functionResponsePart(toolName, callId, { error: msg })] };
}

async function handleGenerateImage(
  toolName: string, callId: string | undefined, args: ToolArgs, ctx: TurnContext, actions: TurnActions, onEvent: EventCallback
): Promise<ToolExecResult> {
  const label = (args.label as string) || 'generated_image';
  const prompt = args.prompt as string;
  const aspectRatio = args.aspect_ratio as string | undefined;
  const referenceImageIds = (args.reference_image_ids as string[] | undefined) ?? [];

  onEvent({ type: 'image_generating', label });

  try {
    const inputImages = (await Promise.all(
      referenceImageIds.map(async (refId) => {
        const img = await actions.getImage(refId);
        if (!img) return null;
        const data = await blobToBase64(img.blob);
        return { data, mimeType: img.mimeType };
      })
    )).filter((img): img is { data: string; mimeType: string } => img !== null);

    const imageResponse = await generateImage(ctx.apiKey, ctx.imageModel, prompt, {
      aspectRatio,
      inputImages: inputImages.length > 0 ? inputImages : undefined,
      signal: ctx.signal
    });
    const blob = await base64ToBlob(imageResponse.imageData, imageResponse.mimeType);
    const stored = await actions.createImage(blob, label, { generationContext: prompt });

    onEvent({ type: 'image_complete', imageId: stored.id, label });

    const thumb = await actions.getImageThumbnail(stored.id);
    const imageParts = thumb
      ? [{ inlineData: { data: thumb.base64, mimeType: thumb.mimeType } }]
      : undefined;
    return {
      responseParts: [
        functionResponsePart(toolName, callId, { output: `Image generated: [image:${stored.id}] "${label}"` }, imageParts)
      ],
      imageId: stored.id
    };
  } catch (err) {
    return toolErrorResult(toolName, callId, err, 'Image generation failed', onEvent);
  }
}

const MAX_VIEW_IMAGES = 6;

async function handleViewImages(
  toolName: string, callId: string | undefined, args: ToolArgs, _ctx: TurnContext, actions: TurnActions, onEvent: EventCallback
): Promise<ToolExecResult> {
  const imageIds = ((args.image_ids as string[]) ?? []).slice(0, MAX_VIEW_IMAGES);
  const reason = args.reason as string | undefined;

  if (imageIds.length === 0) {
    return { responseParts: [functionResponsePart(toolName, callId, { error: 'No image IDs provided.' })] };
  }

  onEvent({ type: 'image_viewing', imageIds, reason });

  try {
    const imageParts: Part[] = [];
    const outputLines: string[] = [];
    const notFound: string[] = [];

    for (const imageId of imageIds) {
      const thumb = await actions.getImageThumbnail(imageId);
      if (!thumb) {
        notFound.push(imageId);
        continue;
      }
      outputLines.push(imageId);
      imageParts.push({ inlineData: { data: thumb.base64, mimeType: thumb.mimeType } });
    }

    if (imageParts.length === 0) {
      return { responseParts: [functionResponsePart(toolName, callId, { error: `Images not found: ${notFound.join(', ')}` })] };
    }

    let output = `Showing ${imageParts.length} image(s) in order: ${outputLines.join(', ')}`;
    if (notFound.length > 0) {
      output += `. Not found: ${notFound.join(', ')}`;
    }

    return {
      responseParts: [functionResponsePart(toolName, callId, { output }, imageParts)]
    };
  } catch (err) {
    return toolErrorResult(toolName, callId, err, 'Failed to view images', onEvent);
  }
}

async function handleReadMemory(
  toolName: string, callId: string | undefined, args: ToolArgs, _ctx: TurnContext, actions: TurnActions, onEvent: EventCallback
): Promise<ToolExecResult> {
  const slug = args.slug as string;

  try {
    const memory = await actions.getAgentMemory(slug);
    if (!memory) {
      const allMemories = await actions.listAgentMemories();
      const available = allMemories.map((t) => t.slug).join(', ');
      const hint = available
        ? `Topic "${slug}" not found. Available topics: ${available}`
        : `Topic "${slug}" not found. No topics exist yet. Use update_memory to create one.`;
      return { responseParts: [functionResponsePart(toolName, callId, { error: hint })] };
    }

    return {
      responseParts: [
        functionResponsePart(toolName, callId, { slug: memory.slug, title: memory.title, content: memory.content })
      ]
    };
  } catch (err) {
    return toolErrorResult(toolName, callId, err, 'Failed to read memory', onEvent);
  }
}

async function handleUpdateMemory(
  toolName: string, callId: string | undefined, args: ToolArgs, _ctx: TurnContext, actions: TurnActions, onEvent: EventCallback
): Promise<ToolExecResult> {
  const slug = args.slug as string;
  const title = args.title as string;
  const summary = args.summary as string;
  const content = args.content as string;

  try {
    await actions.upsertAgentMemory(slug, title, summary, content);
    onEvent({ type: 'memory_updated', slug });

    const verb = content.trim() ? 'updated' : 'deleted';
    return { responseParts: [functionResponsePart(toolName, callId, { output: `Memory topic "${slug}" ${verb}.` })] };
  } catch (err) {
    return toolErrorResult(toolName, callId, err, 'Failed to update memory', onEvent);
  }
}

type ToolHandler = (
  toolName: string, callId: string | undefined, args: ToolArgs, ctx: TurnContext, actions: TurnActions, onEvent: EventCallback
) => Promise<ToolExecResult>;

const toolHandlers: Record<string, ToolHandler> = {
  generate_image: handleGenerateImage,
  view_images: handleViewImages,
  read_memory: handleReadMemory,
  update_memory: handleUpdateMemory,
};

async function executeToolCall(
  call: FunctionCall,
  ctx: TurnContext,
  actions: TurnActions,
  onEvent: EventCallback
): Promise<ToolExecResult> {
  const name = call.name ?? 'unknown';
  const id = call.id;
  const args = call.args ?? {};
  const handler = toolHandlers[name];

  if (!handler) {
    return { responseParts: [functionResponsePart(name, id, { error: `Unknown tool: ${name}` })] };
  }

  return handler(name, id, args, ctx, actions, onEvent);
}

// ── Main orchestration loop ──

let turnInProgress = false;

/**
 * Execute a single agent turn: send the user's message, handle any tool-call
 * rounds, and return everything the caller needs to persist.
 *
 * On error, returns partial results with apiHistory rolled back to its
 * pre-turn state so the conversation can safely continue.
 *
 * @param reattachImageIds - Image IDs from a previous failed turn to re-send
 *   as inline data without re-storing them.
 */
export async function runAgentTurn(
  ctx: TurnContext,
  actions: TurnActions,
  userText: string,
  onEvent: EventCallback,
  attachments: UserAttachment[] = [],
  reattachImageIds: string[] = []
): Promise<TurnResult> {
  if (turnInProgress) {
    onEvent({ type: 'error', message: 'A turn is already in progress.' });
    return { userText: '', userImageIds: [], assistantText: '', assistantImageIds: [], apiHistory: ctx.apiHistory };
  }
  turnInProgress = true;

  try {
    return await runAgentTurnInner(ctx, actions, userText, onEvent, attachments, reattachImageIds);
  } finally {
    turnInProgress = false;
  }
}

async function runAgentTurnInner(
  ctx: TurnContext,
  actions: TurnActions,
  userText: string,
  onEvent: EventCallback,
  attachments: UserAttachment[],
  reattachImageIds: string[]
): Promise<TurnResult> {
  if (!ctx.apiKey) {
    onEvent({ type: 'error', message: 'No API key configured. Add your Gemini API key in settings.' });
    return { userText: '', userImageIds: [], assistantText: '', assistantImageIds: [], apiHistory: ctx.apiHistory };
  }

  const systemPrompt = buildSystemPrompt(ctx.projectName, ctx.agentMemories, ctx.projectImages);
  onEvent({ type: 'debug_system_prompt', prompt: systemPrompt });

  const config = {
    systemInstruction: systemPrompt,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    // LOW thinking: enough for tool-call reasoning without burning tokens on reflection.
    thinkingConfig: { includeThoughts: true, thinkingLevel: ThinkingLevel.LOW }
  };

  let apiHistory = ctx.apiHistory;
  let accumulatedText = '';
  const generatedImageIds: string[] = [];
  let userImageIds: string[] = [];

  try {
    const attachmentResult = await processAttachments(attachments, actions);
    userImageIds = attachmentResult.ids;

    // Re-attach images from a previous failed turn (already stored, just need inline data).
    const reattachParts: Part[] = [];
    for (const imageId of reattachImageIds) {
      const img = await actions.getImage(imageId);
      if (img) {
        const base64 = await blobToBase64(img.blob);
        reattachParts.push({ inlineData: { data: base64, mimeType: img.mimeType } });
        userImageIds.push(imageId);
      }
    }

    // First iteration: user message + attachments. Subsequent iterations: tool response parts.
    let currentParts: Part[] = [{ text: userText }, ...attachmentResult.parts, ...reattachParts];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (_debugFaultRound !== null && round === _debugFaultRound) {
        _debugFaultRound = null;
        throw new Error(`[simulated] Fault injected on round ${round}`);
      }

      onEvent({ type: 'status', text: round === 0 ? 'Thinking...' : 'Processing tool results...' });
      onEvent({ type: 'debug_request', round, parts: redactParts(currentParts), historyLength: apiHistory.length });

      if (ctx.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');

      const { stream, getResult } = await sendMessageStreaming(
        ctx.apiKey,
        ctx.textModel,
        currentParts,
        apiHistory,
        config,
        ctx.signal
      );

      let roundText = '';
      let roundThought = '';
      const debugFunctionCalls: { name: string; args: unknown }[] = [];

      for await (const chunk of stream) {
        if (chunk.textDelta) {
          roundText += chunk.textDelta;
          onEvent({ type: 'text_delta', text: chunk.textDelta });
        }
        if (chunk.thoughtDelta) {
          roundThought += chunk.thoughtDelta;
          onEvent({ type: 'thought_delta', text: chunk.thoughtDelta });
        }
        if (chunk.functionCalls) {
          for (const fc of chunk.functionCalls) {
            debugFunctionCalls.push({ name: fc.name ?? 'unknown', args: fc.args });
          }
        }
      }

      if (roundThought) {
        onEvent({ type: 'debug_thought', round, text: roundThought });
      }

      const result = getResult();
      apiHistory = result.history;

      onEvent({ type: 'debug_response', round, text: result.text, functionCalls: debugFunctionCalls });

      if (roundText) {
        accumulatedText += (accumulatedText ? '\n\n' : '') + roundText;
      }

      if (result.functionCalls.length === 0) break;

      // On the final round, skip tool execution rather than executing
      // side effects the model will never see the results of.
      if (round === MAX_TOOL_ROUNDS - 1) {
        onEvent({ type: 'error', message: `Agent stopped after ${MAX_TOOL_ROUNDS} rounds. Remaining tool calls were not executed.` });
        break;
      }

      // Execute function calls and collect response parts.
      const responseParts: Part[] = [];

      for (let i = 0; i < result.functionCalls.length; i++) {
        const call = result.functionCalls[i];
        if (ctx.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');

        // Defer excess calls to avoid the 3+ parallel call thoughtSignature bug.
        if (i >= MAX_PARALLEL_CALLS) {
          const name = call.name ?? 'unknown';
          responseParts.push(functionResponsePart(name, call.id, {
            error: 'Too many parallel tool calls. Please call this tool again.'
          }));
          onEvent({ type: 'debug_tool_exec', name, args: { _deferred: true } });
          continue;
        }

        const callArgs = (call.args ?? {}) as Record<string, unknown>;
        onEvent({ type: 'debug_tool_exec', name: call.name ?? 'unknown', args: callArgs });

        const execResult = await executeToolCall(call, ctx, actions, onEvent);

        onEvent({ type: 'debug_tool_result', name: call.name ?? 'unknown', result: redactParts(execResult.responseParts) });

        if (execResult.imageId) generatedImageIds.push(execResult.imageId);
        responseParts.push(...execResult.responseParts);
      }

      currentParts = responseParts;
    }
  } catch (err) {
    const cancelled = err instanceof DOMException && err.name === 'AbortError';
    const msg = cancelled ? 'Turn cancelled' : (err instanceof Error ? err.message : String(err));
    onEvent({ type: 'error', message: cancelled ? msg : `API error: ${msg}` });

    const partialAssistantText = appendImageRefs(accumulatedText, generatedImageIds);
    onEvent({ type: 'done', assistantText: partialAssistantText, imageIds: generatedImageIds });

    return {
      userText: appendImageRefs(userText, userImageIds),
      userImageIds,
      assistantText: partialAssistantText,
      assistantImageIds: generatedImageIds,
      // Always roll back to pre-turn history. Intermediate states contain
      // dangling function calls (no tool responses) that the SDK's history
      // curation can't fix, and that corrupt all subsequent turns.
      apiHistory: ctx.apiHistory,
      error: msg
    };
  }

  const finalAssistantText = appendImageRefs(accumulatedText, generatedImageIds);

  onEvent({ type: 'done', assistantText: finalAssistantText, imageIds: generatedImageIds });

  return {
    userText: appendImageRefs(userText, userImageIds),
    userImageIds,
    assistantText: finalAssistantText,
    assistantImageIds: generatedImageIds,
    apiHistory
  };
}
