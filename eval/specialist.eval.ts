/**
 * Specialist prompt eval.
 *
 * Runs specialist agents (text-to-image, image-to-image) with real Gemini
 * text API calls against scenarios defined in eval/scenarios/specialist/.
 * Image generation is mocked so we can inspect the generation prompts the
 * specialists write without burning image API credits.
 *
 * Output is a context dump: the specialist's system instruction followed
 * by its full Content[] history, matching the debug interface snapshot.
 *
 * Run:  pnpm eval
 * Filter: pnpm eval -- -t "forest"
 */
import { describe, it, vi, beforeAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '@google/genai';
import {
  createMockStores,
  createMockActions,
  createContext,
  createSubagentTrace,
  instrumentDefinition,
  PLACEHOLDER_PNG
} from './harness';
import { loadScenarios } from './scenario-loader';
import { buildContextDump } from '$lib/engine/context-dump';

// ── Mocks ──

// Mock image generation to return a placeholder. Text model calls are real.
vi.mock('$lib/engine/gemini', async (importOriginal) => {
  const mod = await importOriginal<typeof import('$lib/engine/gemini')>();
  return {
    ...mod,
    generateImage: vi.fn(async () => ({
      imageData: PLACEHOLDER_PNG,
      mimeType: 'image/png'
    }))
  };
});

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

// ── Runner ──

const TRACE_DIR = join(import.meta.dirname, 'traces');
const scenarios = loadScenarios('specialist');
const apiKey = process.env.GEMINI_API_KEY;

describe.skipIf(!apiKey)('Specialist prompt quality', () => {
  beforeAll(() => {
    mkdirSync(TRACE_DIR, { recursive: true });
  });

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const { runSubagent } = await import('$lib/engine/subagent');
      const { getTextToImageAgent } = await import('$lib/engine/agents/text-to-image');
      const { getImageToImageAgent } = await import('$lib/engine/agents/image-to-image');

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

      const agentType = scenario.agent as 'text-to-image' | 'image-to-image';
      const getAgent = agentType === 'text-to-image'
        ? getTextToImageAgent
        : getImageToImageAgent;
      const definition = getAgent(
        ctx.projectName,
        ctx.agentMemories,
        ctx.projectImages,
        ctx.totalMemoryCount,
        ctx.totalImageCount
      );

      const trace = createSubagentTrace(scenario.name, agentType, scenario.prompt);
      const instrumented = instrumentDefinition(definition, trace);

      let systemPrompt = instrumented.systemPrompt;
      let history: Content[] = [];

      try {
        const result = await runSubagent(
          instrumented,
          scenario.prompt,
          ctx,
          actions,
          () => {}
        );

        if (!trace.handoffText && result.text) {
          trace.handoffText = result.text;
        }

        systemPrompt = result.systemPrompt;
        history = result.history;
      } catch (err) {
        trace.error = err instanceof Error ? err.message : String(err);
      }

      let { text } = buildContextDump(systemPrompt, history);
      if (trace.error) {
        text += `\n=== ERROR ===\n\n${trace.error}\n`;
      }

      const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      writeFileSync(join(TRACE_DIR, `${slug}.txt`), text, 'utf-8');
    });
  }
});
