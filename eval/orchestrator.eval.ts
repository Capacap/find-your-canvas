/**
 * Orchestrator prompt eval.
 *
 * Runs the orchestrator with real Gemini text API calls against scenarios
 * defined in eval/scenarios/orchestrator/. Subagent execution is mocked
 * so we can inspect the creative briefs the orchestrator writes without
 * running specialists or burning image generation credits.
 *
 * Output is a context dump identical to the debug interface snapshot:
 * system instruction followed by the full Content[] history with
 * subagent sessions inlined at their dispatch points.
 *
 * Run:  pnpm eval
 * Filter: pnpm eval -- -t "sunset"
 */
import { describe, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMockStores,
  createMockActions,
  createContext
} from './harness';
import { loadScenarios } from './scenario-loader';
import { getRunDir } from './run-dir';
import { buildContextDump } from '$lib/engine/context-dump';

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

// ── Runner ──

const scenarios = loadScenarios('orchestrator');
const apiKey = process.env.GEMINI_API_KEY;

describe.skipIf(!apiKey)('Orchestrator dispatch quality', () => {
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

      const result = await runAgentTurn(ctx, actions, scenario.prompt, () => {});

      const { text } = buildContextDump(
        result.systemPrompt,
        result.apiHistory,
        result.subagentSessions
      );

      const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      writeFileSync(join(getRunDir(), `${slug}.txt`), text, 'utf-8');
    });
  }
});
