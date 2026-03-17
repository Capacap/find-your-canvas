/**
 * Eval harness for testing agent prompts against real Gemini API calls.
 *
 * Provides mock TurnActions (in-memory storage), a trace collector that
 * captures engine events, and helpers for building TurnContext. The Gemini
 * text model is called for real; image generation and subagent execution
 * are mocked so we can inspect what the agents write without burning
 * image API credits.
 */
import type { TurnContext, TurnActions, EngineEvent, AgentDefinition, ToolHandler } from '$lib/engine/types';
import type { AgentMemory, ImageMeta, ImageBlob, ImageSource } from '$lib/types/schema';
import { TEXT_MODEL, IMAGE_MODEL } from '$lib/types/schema';

// ── Tiny placeholder image ──

/** 64x64 solid-color PNG, base64-encoded. Large enough for the Gemini API to accept. */
export const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsBeHOMThCWRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0Bm1hyaN8svxYAAAAASUVORK5CYII=';

// ── Mock storage ──

export interface MockStores {
  images: Map<string, ImageMeta & { blob: Blob }>;
  memories: Map<string, AgentMemory>;
}

function makeId(): string {
  return 'mock-' + Math.random().toString(36).slice(2, 10);
}

export function createMockStores(opts?: {
  memories?: AgentMemory[];
  images?: ImageMeta[];
}): MockStores {
  const stores: MockStores = {
    images: new Map(),
    memories: new Map()
  };

  if (opts?.memories) {
    for (const m of opts.memories) stores.memories.set(m.slug, m);
  }
  if (opts?.images) {
    const placeholderBlob = new Blob([Buffer.from(PLACEHOLDER_PNG, 'base64')], { type: 'image/png' });
    for (const img of opts.images) {
      stores.images.set(img.id, { ...img, blob: placeholderBlob });
    }
  }

  return stores;
}

export function createMockActions(stores: MockStores): TurnActions {
  const placeholderBlob = new Blob([Buffer.from(PLACEHOLDER_PNG, 'base64')], { type: 'image/png' });

  return {
    async createImage(blob: Blob, label: string, opts?: { source?: ImageSource; generationContext?: string }): Promise<ImageMeta> {
      const id = makeId();
      const now = Date.now();
      const meta: ImageMeta = {
        id,
        projectId: 'eval-project',
        source: opts?.source ?? 'generated',
        mimeType: 'image/png',
        label,
        generationContext: opts?.generationContext,
        thumbnail: placeholderBlob,
        createdAt: now,
        lastAccessedAt: now
      };
      stores.images.set(id, { ...meta, blob });
      return meta;
    },

    async getImage(id: string): Promise<(ImageMeta & ImageBlob) | undefined> {
      const entry = stores.images.get(id);
      if (!entry) return undefined;
      return { ...entry, id, blob: entry.blob };
    },

    async getImageThumbnail(id: string): Promise<{ base64: string; mimeType: string } | undefined> {
      // Auto-create placeholder entries for mock-generated image IDs
      // so dispatch handler thumbnail lookups work.
      if (!stores.images.has(id)) {
        stores.images.set(id, {
          id,
          projectId: 'eval-project',
          source: 'generated',
          mimeType: 'image/png',
          label: 'mock-image',
          thumbnail: placeholderBlob,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          blob: placeholderBlob
        });
      }
      return { base64: PLACEHOLDER_PNG, mimeType: 'image/png' };
    },

    async touchImages(_ids: string[]): Promise<void> {},

    async searchImages(query: string): Promise<ImageMeta[]> {
      const q = query.toLowerCase();
      const results: ImageMeta[] = [];
      for (const img of stores.images.values()) {
        if (img.label.toLowerCase().includes(q) || img.generationContext?.toLowerCase().includes(q)) {
          results.push(img);
        }
      }
      return results;
    },

    async getAgentMemory(slug: string): Promise<AgentMemory | undefined> {
      return stores.memories.get(slug);
    },

    async listAgentMemories(): Promise<AgentMemory[]> {
      return Array.from(stores.memories.values());
    },

    async upsertAgentMemory(slug: string, title: string, summary: string, content: string): Promise<void> {
      const now = Date.now();
      const existing = stores.memories.get(slug);
      stores.memories.set(slug, {
        id: existing?.id ?? makeId(),
        projectId: 'eval-project',
        slug,
        title,
        summary,
        content,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastAccessedAt: now
      });
    },

    async touchMemory(_slug: string): Promise<void> {},

    async searchMemories(query: string): Promise<AgentMemory[]> {
      const q = query.toLowerCase();
      const results: AgentMemory[] = [];
      for (const mem of stores.memories.values()) {
        if (
          mem.slug.toLowerCase().includes(q) ||
          mem.title.toLowerCase().includes(q) ||
          mem.summary.toLowerCase().includes(q)
        ) {
          results.push(mem);
        }
      }
      return results;
    }
  };
}

// ── Event collector ──

/**
 * Listens to EngineEvents during a turn. The collected events are not
 * used for trace output (context dumps handle that), but they're still
 * useful for programmatic assertions in tests (e.g. checking which
 * dispatch tool was called, or extracting dispatch prompts).
 */
export class EventCollector {
  dispatches: Array<{ agentType: string; prompt: string }> = [];
  finalText = '';
  error?: string;

  onEvent = (event: EngineEvent): void => {
    switch (event.type) {
      case 'debug_tool_exec':
        if (event.name === 'dispatch_text_to_image' || event.name === 'dispatch_image_to_image') {
          const agentType = event.name === 'dispatch_text_to_image' ? 'text-to-image' : 'image-to-image';
          this.dispatches.push({
            agentType,
            prompt: (event.args.prompt as string) ?? ''
          });
        }
        break;

      case 'error':
        this.error = event.message;
        break;

      case 'done':
        this.finalText = event.assistantText;
        break;
    }
  };
}

// ── Subagent trace ──

/** What a specialist did during its run. */
export interface SubagentTrace {
  scenario: string;
  agentType: string;
  dispatch: string;
  generations: Array<{
    prompt: string;
    label: string;
    aspectRatio?: string;
    referenceIds: string[];
  }>;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  handoffText: string;
  error?: string;
}

/**
 * Wrap an AgentDefinition's handlers with interceptors that record
 * tool calls into a SubagentTrace. The subagent runner doesn't emit
 * debug events, so this is how we capture specialist behavior.
 */
export function instrumentDefinition(
  definition: AgentDefinition,
  trace: SubagentTrace
): AgentDefinition {
  const wrappedHandlers: Record<string, ToolHandler> = {};

  for (const [name, handler] of Object.entries(definition.toolHandlers)) {
    wrappedHandlers[name] = async (toolName, callId, args, ctx, actions, onEvent) => {
      trace.toolCalls.push({ name, args: { ...args } });

      // Capture generate_image prompts (the main eval output).
      if (name === 'generate_image') {
        trace.generations.push({
          prompt: (args.prompt as string) ?? '',
          label: (args.label as string) ?? '',
          aspectRatio: args.aspect_ratio as string | undefined,
          referenceIds: (args.reference_image_ids as string[]) ?? []
        });
      }

      const result = await handler(toolName, callId, args, ctx, actions, onEvent);

      // Capture handoff text.
      if (name === 'handoff' && result.handoffText) {
        trace.handoffText = result.handoffText;
      }

      return result;
    };
  }

  return { ...definition, toolHandlers: wrappedHandlers };
}

export function createSubagentTrace(scenario: string, agentType: string, dispatch: string): SubagentTrace {
  return { scenario, agentType, dispatch, generations: [], toolCalls: [], handoffText: '' };
}

// ── Context builder ──

export function createContext(opts: {
  apiKey: string;
  memories?: AgentMemory[];
  images?: ImageMeta[];
  signal?: AbortSignal;
}): TurnContext {
  return {
    apiKey: opts.apiKey,
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    projectName: 'Eval Project',
    agentMemories: opts.memories ?? [],
    totalMemoryCount: opts.memories?.length ?? 0,
    projectImages: opts.images ?? [],
    totalImageCount: opts.images?.length ?? 0,
    apiHistory: [],
    signal: opts.signal
  };
}
