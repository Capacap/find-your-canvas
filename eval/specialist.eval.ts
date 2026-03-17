/**
 * Specialist prompt eval.
 *
 * Runs specialist agents (text-to-image, image-to-image) with real Gemini
 * text API calls against defined dispatch prompts. Image generation is
 * mocked so we can inspect the generation prompts the specialists write
 * without burning image API credits.
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
import type { AgentMemory, ImageMeta } from '$lib/types/schema';
import type { Content } from '@google/genai';
import {
  createMockStores,
  createMockActions,
  createContext,
  createSubagentTrace,
  instrumentDefinition,
  PLACEHOLDER_PNG
} from './harness';
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

// ── Scenarios ──

interface SpecialistScenario {
  name: string;
  agentType: 'text-to-image' | 'image-to-image';
  /** The creative brief from the orchestrator. */
  dispatch: string;
  memories?: AgentMemory[];
  images?: ImageMeta[];
}

const now = Date.now();

const scenarios: SpecialistScenario[] = [
  // ── Text-to-image scenarios ──
  {
    name: 'T2I: Simple scene from brief',
    agentType: 'text-to-image',
    dispatch:
      'The user wants a moody establishing shot of a canyon at dusk to set the tone for a story scene. ' +
      'The canyon should feel vast and ancient. Warm color palette shifting to cool at the top of the sky. ' +
      'No characters in frame. The mood should be contemplative, not threatening.'
  },
  {
    name: 'T2I: Character with memory context',
    agentType: 'text-to-image',
    dispatch:
      'Generate a portrait of our protagonist Kael. ' +
      'Refer to the "protagonist" memory for his full appearance details. ' +
      'The portrait should be a medium close-up, showing his face and upper body. ' +
      'He should look weathered but alert, like he has been traveling for days. ' +
      'Use the project\'s established style (slightly stylized realism, warm palette, visible brushstrokes).',
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
    name: 'T2I: Multi-reference composition',
    agentType: 'text-to-image',
    dispatch:
      'Combine elements from three reference images into a single scene. ' +
      'Use [image:img-char] for the character (Kael, take his face, build, and clothing). ' +
      'Use [image:img-bg] for the environment (misty forest, take the atmosphere and tree scale). ' +
      'Use [image:img-style] for the rendering style (apply its brushwork and color grading to the whole image). ' +
      'Kael should be walking through the forest, mid-stride, looking ahead. ' +
      'The composition should emphasize the forest\'s scale relative to the character. ' +
      'Success criteria: the style transfer should be the most noticeable element.',
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
  },

  // ── Image-to-image scenarios ──
  {
    name: 'I2I: Simple edit',
    agentType: 'image-to-image',
    dispatch:
      'Darken the sky in [image:img-sunset] to a deep twilight. ' +
      'Preserve the beach, waves, and sand colors. ' +
      'The lighting on the water should shift to reflect the darker sky naturally.',
    images: [
      {
        id: 'img-sunset',
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
    name: 'I2I: Multi-step transformation',
    agentType: 'image-to-image',
    dispatch:
      'Two changes to [image:img-scene]: ' +
      '1. Add a campfire in the foreground, left of center. It should match the existing lighting and style. ' +
      '2. Change the time of day from afternoon to evening, shifting the sky to warm oranges and purples. ' +
      'Preserve the character and the forest background.',
    images: [
      {
        id: 'img-scene',
        projectId: 'eval-project',
        source: 'generated',
        mimeType: 'image/png',
        label: 'kael_forest_clearing',
        generationContext: 'Kael standing in a sunlit forest clearing, afternoon light, stylized realism',
        thumbnail: new Blob([Buffer.from(PLACEHOLDER_PNG, 'base64')], { type: 'image/png' }),
        createdAt: now - 60_000,
        lastAccessedAt: now - 30_000
      }
    ]
  }
];

// ── Runner ──

const TRACE_DIR = join(import.meta.dirname, 'traces');
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

      const getAgent = scenario.agentType === 'text-to-image'
        ? getTextToImageAgent
        : getImageToImageAgent;
      const definition = getAgent(
        ctx.projectName,
        ctx.agentMemories,
        ctx.projectImages,
        ctx.totalMemoryCount,
        ctx.totalImageCount
      );

      // Instrument handlers to capture generation prompts for assertions.
      const trace = createSubagentTrace(scenario.name, scenario.agentType, scenario.dispatch);
      const instrumented = instrumentDefinition(definition, trace);

      let systemPrompt = instrumented.systemPrompt;
      let history: Content[] = [];

      try {
        const result = await runSubagent(
          instrumented,
          scenario.dispatch,
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
