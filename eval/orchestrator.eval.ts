/**
 * Orchestrator prompt eval.
 *
 * Runs the orchestrator with real Gemini text API calls against defined
 * scenarios. Subagent execution is mocked so we can inspect the creative
 * briefs the orchestrator writes without running specialists or burning
 * image generation credits.
 *
 * Output is a context dump identical to the debug interface snapshot:
 * system instruction followed by the full Content[] history with
 * subagent sessions inlined at their dispatch points.
 *
 * Run:  pnpm eval
 * Filter: pnpm eval -- -t "sunset"
 */
import { describe, it, vi, beforeAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMemory, ImageMeta } from '$lib/types/schema';
import {
  createMockStores,
  createMockActions,
  createContext,
  EventCollector,
  PLACEHOLDER_PNG
} from './harness';
import { buildContextDump } from '$lib/engine/context-dump';

const TRACE_DIR = join(import.meta.dirname, 'traces');

// ── Mocks ──

// Mock subagent runner so dispatch handlers don't actually run specialists.
vi.mock('$lib/engine/subagent', () => ({
  runSubagent: vi.fn(async (_def: unknown, prompt: string) => ({
    text: `[mock specialist] Received dispatch: ${prompt.slice(0, 80)}...`,
    imageIds: ['mock-gen-' + Math.random().toString(36).slice(2, 8)],
    history: [],
    systemPrompt: '[mocked]'
  }))
}));

// Node-compatible replacements for browser blob utilities.
vi.mock('$lib/utils', () => ({
  blobToBase64: async (blob: Blob) => {
    const buffer = Buffer.from(await blob.arrayBuffer());
    return buffer.toString('base64');
  },
  base64ToBlob: async (base64: string, mimeType: string) => {
    const buffer = Buffer.from(base64, 'base64');
    return new Blob([buffer], { type: mimeType });
  },
  blobToObjectUrl: () => 'blob:mock'
}));

// ── Scenarios ──

interface Scenario {
  name: string;
  userMessage: string;
  memories?: AgentMemory[];
  images?: ImageMeta[];
}

const now = Date.now();

const scenarios: Scenario[] = [
  {
    name: 'Simple generation request',
    userMessage: 'Generate a sunset over the ocean.'
  },
  {
    name: 'Vague request (should clarify)',
    userMessage: 'Make something cool.'
  },
  {
    name: 'Edit request with existing image',
    userMessage: 'Make the sky darker in [image:img-001].',
    images: [
      {
        id: 'img-001',
        projectId: 'eval-project',
        source: 'generated',
        mimeType: 'image/png',
        label: 'sunset_beach',
        generationContext: 'A warm sunset over a sandy beach with gentle waves',
        thumbnail: new Blob([Buffer.from(PLACEHOLDER_PNG, 'base64')], { type: 'image/png' }),
        createdAt: now - 60_000,
        lastAccessedAt: now - 30_000
      }
    ]
  },
  {
    name: 'Generation with memory context',
    userMessage: 'Draw our protagonist exploring the forest.',
    memories: [
      {
        id: 'mem-001',
        projectId: 'eval-project',
        slug: 'protagonist',
        title: 'Protagonist',
        summary: 'Main character: Kael, lean build, dark skin, silver-white dreadlocks, amber eyes, wears a weathered brown leather jacket.',
        content: '# Kael\n\nLean build, early 30s. Dark brown skin, silver-white dreadlocks pulled back. Amber eyes. Always wears a weathered brown leather jacket with brass buckles. Carries a satchel covered in patches. Has a thin scar across the bridge of his nose.\n\n## Style notes\nSlightly stylized realism, warm color palette, visible brushstrokes.',
        createdAt: now - 300_000,
        updatedAt: now - 120_000,
        lastAccessedAt: now - 60_000
      }
    ]
  },
  {
    name: 'Multi-reference composition',
    userMessage: 'Combine the character from [image:img-char] with the background from [image:img-bg]. Same style as [image:img-style].',
    images: [
      {
        id: 'img-char',
        projectId: 'eval-project',
        source: 'generated',
        mimeType: 'image/png',
        label: 'kael_portrait',
        generationContext: 'Portrait of Kael, dark skin, silver dreadlocks, amber eyes, leather jacket',
        thumbnail: new Blob([Buffer.from(PLACEHOLDER_PNG, 'base64')], { type: 'image/png' }),
        createdAt: now - 120_000,
        lastAccessedAt: now - 60_000
      },
      {
        id: 'img-bg',
        projectId: 'eval-project',
        source: 'generated',
        mimeType: 'image/png',
        label: 'misty_forest',
        generationContext: 'Dense forest with morning mist filtering through ancient trees, dappled sunlight',
        thumbnail: new Blob([Buffer.from(PLACEHOLDER_PNG, 'base64')], { type: 'image/png' }),
        createdAt: now - 90_000,
        lastAccessedAt: now - 45_000
      },
      {
        id: 'img-style',
        projectId: 'eval-project',
        source: 'user',
        mimeType: 'image/png',
        label: 'style_reference',
        thumbnail: new Blob([Buffer.from(PLACEHOLDER_PNG, 'base64')], { type: 'image/png' }),
        createdAt: now - 200_000,
        lastAccessedAt: now - 100_000
      }
    ]
  }
];

// ── Runner ──

const apiKey = process.env.GEMINI_API_KEY;

describe.skipIf(!apiKey)('Orchestrator dispatch quality', () => {
  beforeAll(() => {
    mkdirSync(TRACE_DIR, { recursive: true });
  });

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const { runAgentTurn } = await import('$lib/engine/turn');

      const stores = createMockStores({
        memories: scenario.memories,
        images: scenario.images
      });
      const actions = createMockActions(stores);
      const ctx = createContext({
        apiKey: apiKey!,
        memories: scenario.memories,
        images: scenario.images
      });

      const events = new EventCollector();
      const result = await runAgentTurn(ctx, actions, scenario.userMessage, events.onEvent);

      const { text } = buildContextDump(
        result.systemPrompt,
        result.apiHistory,
        result.subagentSessions
      );

      const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      writeFileSync(join(TRACE_DIR, `${slug}.txt`), text, 'utf-8');
    });
  }
});
