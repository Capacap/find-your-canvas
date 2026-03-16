/**
 * Eval harness for testing agent prompts against real Gemini API calls.
 *
 * Provides mock TurnActions (in-memory storage), a trace collector that
 * captures engine events, and helpers for building TurnContext. The Gemini
 * text model is called for real; image generation and subagent execution
 * are mocked so we can inspect what the agents write without burning
 * image API credits.
 */
import type { TurnContext, TurnActions, EngineEvent } from '$lib/engine/types';
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

// ── Trace collector ──

interface TraceRound {
  round: number;
  thought: string;
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  toolResults: Array<{ name: string; result: unknown }>;
}

export interface Trace {
  scenario: string;
  userMessage: string;
  rounds: TraceRound[];
  dispatches: Array<{ agentType: string; prompt: string }>;
  finalText: string;
  error?: string;
}

export class TraceCollector {
  private rounds: TraceRound[] = [];
  private currentRound: TraceRound | null = null;
  private dispatches: Array<{ agentType: string; prompt: string }> = [];
  private finalText = '';
  private error?: string;

  onEvent = (event: EngineEvent): void => {
    switch (event.type) {
      case 'debug_request':
        this.currentRound = {
          round: event.round,
          thought: '',
          text: '',
          toolCalls: [],
          toolResults: []
        };
        this.rounds.push(this.currentRound);
        break;

      case 'debug_thought':
        if (this.currentRound) this.currentRound.thought = event.text;
        break;

      case 'debug_response':
        if (this.currentRound) this.currentRound.text = event.text;
        break;

      case 'debug_tool_exec': {
        if (this.currentRound) {
          this.currentRound.toolCalls.push({
            name: event.name,
            args: event.args
          });
        }
        // Capture dispatch prompts.
        if (event.name === 'dispatch_text_to_image' || event.name === 'dispatch_image_to_image') {
          const agentType = event.name === 'dispatch_text_to_image' ? 'text-to-image' : 'image-to-image';
          this.dispatches.push({
            agentType,
            prompt: (event.args.prompt as string) ?? ''
          });
        }
        break;
      }

      case 'debug_tool_result':
        if (this.currentRound) {
          this.currentRound.toolResults.push({
            name: event.name,
            result: event.result
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

  toTrace(scenario: string, userMessage: string): Trace {
    return {
      scenario,
      userMessage,
      rounds: this.rounds,
      dispatches: this.dispatches,
      finalText: this.finalText,
      error: this.error
    };
  }
}

// ── Trace formatting ──

export function formatTrace(trace: Trace): string {
  const lines: string[] = [];
  const sep = '═'.repeat(70);
  const thin = '─'.repeat(70);

  lines.push(sep);
  lines.push(`  SCENARIO: ${trace.scenario}`);
  lines.push(`  USER: ${trace.userMessage}`);
  lines.push(sep);

  // Dispatches first (the main thing we're evaluating).
  if (trace.dispatches.length > 0) {
    lines.push('');
    lines.push('  DISPATCHES:');
    for (let i = 0; i < trace.dispatches.length; i++) {
      const d = trace.dispatches[i];
      lines.push(thin);
      lines.push(`  [${i + 1}] ${d.agentType}`);
      lines.push('');
      // Indent the dispatch prompt for readability.
      for (const line of d.prompt.split('\n')) {
        lines.push(`    ${line}`);
      }
    }
    lines.push(thin);
  }

  // Full trace for context.
  lines.push('');
  lines.push('  TRACE:');

  for (const round of trace.rounds) {
    lines.push('');
    lines.push(`  ── Round ${round.round} ──`);

    if (round.thought) {
      lines.push(`  [thought] ${truncate(round.thought, 200)}`);
    }

    if (round.text) {
      lines.push(`  [text] ${round.text}`);
    }

    for (const call of round.toolCalls) {
      if (call.name.startsWith('dispatch_')) {
        lines.push(`  [tool] ${call.name} → (see DISPATCHES above)`);
      } else {
        const argStr = JSON.stringify(call.args, null, 2)
          .split('\n')
          .map((l, i) => (i === 0 ? l : `         ${l}`))
          .join('\n');
        lines.push(`  [tool] ${call.name} ${argStr}`);
      }
    }
  }

  if (trace.error) {
    lines.push('');
    lines.push(`  ERROR: ${trace.error}`);
  }

  lines.push('');
  lines.push(sep);

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
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
