/**
 * TTI prompt strategy comparison.
 *
 * Runs three text-to-image specialist variants (instructional, prose,
 * spec sheet) against the same briefs with real image generation.
 * Produces a side-by-side HTML comparison page for visual evaluation.
 *
 * Run:  GEMINI_API_KEY=... pnpm eval:tti
 *
 * Output: eval/traces/{timestamp}/tti-variants/ with images and
 * comparison.html for visual evaluation.
 */
import { describe, it, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '@google/genai';
import {
  createMockStores,
  createMockActions,
  createContext,
  createSubagentTrace,
  instrumentDefinition
} from './harness';
import { getRunDir } from './run-dir';
import { buildContextDump } from '$lib/engine/context-dump';
import type { AgentDefinition } from '$lib/engine/types';
import {
  generateImageDeclaration,
  viewImagesDeclaration,
  readMemoryDeclaration,
  searchImagesDeclaration,
  searchMemoriesDeclaration,
  handoffDeclaration,
  handleGenerateImage,
  handleViewImages,
  handleReadMemory,
  handleSearchImages,
  handleSearchMemories,
  handleHandoff
} from '$lib/engine/tools';
import { interpolate, buildMemorySection, buildImageIndex } from '$lib/engine/prompts';

// ── Prompt sections (raw text) ──

import ttiIdentity from '$lib/engine/prompts/sections/tti-identity.txt?raw';
import specialistConfidence from '$lib/engine/prompts/sections/specialist-confidence.txt?raw';
import referenceImages from '$lib/engine/prompts/sections/reference-images.txt?raw';
import contentFilter from '$lib/engine/prompts/sections/content-filter.txt?raw';

// Variants
import ttiSpecsheetMinimal from './tti-specsheet-minimal.txt?raw';
import ttiSpecsheetAugmented from './tti-specsheet-augmented.txt?raw';
import ttiSpecsheetTechnical from './tti-specsheet-technical.txt?raw';

// ── Node-compatible blob utilities (same as specialist eval) ──

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

// NOTE: We do NOT mock generateImage. Real image generation runs here.

// ── Assembly ──

function assemble(...sections: string[]): string {
  return sections.map(s => s.trim()).join('\n\n');
}

const variantTemplates: Record<string, string> = {
  minimal: assemble(ttiIdentity, specialistConfidence, ttiSpecsheetMinimal, referenceImages, contentFilter, '{{memorySection}}', '{{imageIndexSection}}'),
  augmented: assemble(ttiIdentity, specialistConfidence, ttiSpecsheetAugmented, referenceImages, contentFilter, '{{memorySection}}', '{{imageIndexSection}}'),
  technical: assemble(ttiIdentity, specialistConfidence, ttiSpecsheetTechnical, referenceImages, contentFilter, '{{memorySection}}', '{{imageIndexSection}}'),
};

function makeAgent(variantKey: string): AgentDefinition {
  const template = variantTemplates[variantKey];
  const systemPrompt = interpolate(template, {
    projectName: 'Stone Age Indie Game',
    memorySection: buildMemorySection([]),
    imageIndexSection: buildImageIndex([])
  });

  return {
    systemPrompt,
    toolDeclarations: [
      generateImageDeclaration,
      viewImagesDeclaration,
      readMemoryDeclaration,
      searchImagesDeclaration,
      searchMemoriesDeclaration,
      handoffDeclaration
    ],
    toolHandlers: {
      generate_image: handleGenerateImage,
      view_images: handleViewImages,
      read_memory: handleReadMemory,
      search_images: handleSearchImages,
      search_memories: handleSearchMemories,
      handoff: handleHandoff
    }
  };
}

// ── Config ──

const ATTEMPTS = Number(process.env.TTI_ATTEMPTS ?? 3);

// ── Test briefs ──

const briefs: Record<string, string> = {
  cave: [
    'The user wants concept art of an abandoned Stone Age cave dwelling.',
    'A natural limestone cavern that was once home to a small family group.',
    'Cold, long-dead hearth in the center. Ochre and charcoal handprints on the far wall, adults and children, overlapping a faded hunting mural of a massive rhinoceros.',
    'Scattered domestic remains: cured hides for bedding, a few crude stone tools, cracked animal bones.',
    'Style: gritty digital painting with visible brushstrokes, heavy atmospheric contrast, desaturated earth tones.',
    'Lighting should be somber and horror-adjacent. Faint cold daylight from a distant cave entrance, deep shadows.',
    'What matters most: the cave must feel like a real place where people lived and then vanished. The handprints are the emotional anchor.',
    '16:9 aspect ratio.'
  ].join(' '),

  steppes: [
    'The user wants a wide landscape of rolling highland steppes at dusk.',
    'Vast, open terrain with wind-swept golden dry grass in the foreground, rolling hills receding into the distance.',
    'A lone figure, barely visible, walks a ridge line in the middle distance.',
    'Style: gritty painterly digital art, heavy atmospheric perspective, desaturated warm tones fading to cold blue-grey at the horizon.',
    'Mood: isolated, vast, melancholy. The scale of the landscape should dwarf the human figure.',
    'What matters most: the sense of scale and isolation.',
    '21:9 aspect ratio.'
  ].join(' '),

  confrontation: [
    'The user wants an action shot of a Stone Age survivor confronting a massive, monstrous Elasmotherium.',
    'Low angle, dynamic composition emphasizing the extreme size difference.',
    'The survivor is lean and weathered, wearing simple fur clothing, mid-throw with a bone-tipped javelin.',
    'The Elasmotherium is hulking, scarred, with matted fur and a single massive horn. Several old javelin shafts are embedded in its hide from previous encounters.',
    'Style: gritty concept art, painterly with visible brushstrokes, high contrast, desaturated earth palette.',
    'Setting: open highland with wind-swept grass.',
    'What matters most: the dynamic energy of the throw and the terrifying scale of the beast.',
    '16:9 aspect ratio.'
  ].join(' '),

  elder_portrait: [
    'The user wants a close-up character portrait of a Stone Age tribal elder.',
    'Weathered face, deep-set eyes with intelligence and wariness. Ritual scarring across the cheekbones in deliberate geometric lines.',
    'A necklace of animal teeth and small carved bone beads. Grey-streaked hair pulled back and bound with sinew.',
    'Background is out of focus: warm firelight suggesting an interior space.',
    'Style: gritty digital painting, tight brushwork on skin texture, looser strokes in the background.',
    'Lighting: warm, directional firelight from below-left casting deep shadows across the right side of the face.',
    'What matters most: the face must convey a specific person with history, not a generic primitive.',
    '3:4 aspect ratio.'
  ].join(' '),

  ritual_site: [
    'The user wants a wide shot of a Stone Age ritual site at night.',
    'A circle of tall standing stones on a hilltop, weathered and lichen-covered. The stones are rough-hewn, not smoothly carved.',
    'A large bonfire in the center throws shifting orange light across the inner faces of the stones. Sparks drift upward.',
    'Several small human silhouettes stand around the fire. Their postures suggest ceremony, not casual gathering.',
    'Style: gritty painterly digital art with heavy atmospheric effects. Smoke and firelight haze.',
    'Palette: deep blue-black sky, warm orange fire, cool grey stones. Strong contrast between lit and unlit areas.',
    'The stars are visible above, cold and sharp against the smoke.',
    'What matters most: the contrast between the vast dark sky and the contained circle of warmth and light.',
    '21:9 aspect ratio.'
  ].join(' '),

  shelter_interior: [
    'The user wants concept art of a Stone Age lean-to shelter interior, lived-in and domestic.',
    'A structure of bent saplings covered in layered animal hides. The interior is cramped but organized.',
    'Specific items: a stone mortar and pestle with crushed ochre, bundled dried herbs hanging from the frame, a sleeping area of layered furs, a small child asleep in the furs.',
    'Daylight filters through gaps in the hide covering, creating dappled warm light patterns across the interior.',
    'Style: gritty painterly digital art, detailed textures on materials (fur, hide, wood grain, stone).',
    'Mood: quiet, intimate, domestic. This is a home.',
    'What matters most: the accumulated detail of daily life. This should feel like a real living space, not a museum diorama.',
    '16:9 aspect ratio.'
  ].join(' '),

  migration: [
    'The user wants a mid-distance shot of a Stone Age group migrating across a river ford.',
    'Eight to twelve figures crossing a wide, shallow river. Adults carry bundles and tools. One figure carries a small child on their shoulders. A dog wades alongside.',
    'The water is knee-deep, clear over a gravel bed. The far bank rises into birch forest with autumn foliage.',
    'Style: gritty concept art, painterly with visible brushstrokes, desaturated earth palette with pops of autumn color.',
    'Lighting: overcast daylight, soft and even. Reflections in the shallow water.',
    'What matters most: the sense of collective effort and movement. Individual figures should have distinct postures and burdens.',
    '21:9 aspect ratio.'
  ].join(' '),

  predator_night: [
    'The user wants a tense scene of a Stone Age camp at night with a predator lurking at the edge of firelight.',
    'A small campfire in a forest clearing. Two figures huddle near it, one gripping a spear, both looking outward into the dark.',
    'Just beyond the firelight, barely visible: the reflective eyes and partial silhouette of a large cave hyena. Its body is mostly swallowed by darkness.',
    'Style: gritty digital painting, heavy use of shadow. The firelight is the only light source.',
    'Palette: warm amber in the tiny fire circle, near-black everywhere else. The transition from light to dark is abrupt.',
    'What matters most: the contrast between the tiny safe zone of firelight and the vast threatening dark. The predator should be suggested more than shown.',
    '16:9 aspect ratio.'
  ].join(' ')
};

// ── Runner ──

const apiKey = process.env.GEMINI_API_KEY;
const variantKeys = Object.keys(variantTemplates);
const briefKeys = Object.keys(briefs);

describe.skipIf(!apiKey)('TTI prompt strategy comparison', () => {
  const outDir = join(getRunDir(), 'tti-variants');
  mkdirSync(outDir, { recursive: true });

  const results: Array<{
    variant: string;
    brief: string;
    attempt: number;
    filename: string;
    prompt: string;
    handoff: string;
    error?: string;
  }> = [];

  for (const briefKey of briefKeys) {
    for (const variantKey of variantKeys) {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const suffix = ATTEMPTS > 1 ? ` #${attempt}` : '';
        const testName = `${briefKey} × ${variantKey}${suffix}`;

        it(testName, async () => {
          const { runSubagent } = await import('$lib/engine/subagent');

          const stores = createMockStores();
          const actions = createMockActions(stores);
          const ctx = createContext({ apiKey: apiKey! });
          const definition = makeAgent(variantKey);

          const trace = createSubagentTrace(testName, 'text-to-image', briefs[briefKey]);
          const instrumented = instrumentDefinition(definition, trace);

          let systemPrompt = instrumented.systemPrompt;
          let history: Content[] = [];
          let handoff = '';
          let error: string | undefined;
          const fileSuffix = ATTEMPTS > 1 ? `_${attempt}` : '';

          try {
            const result = await runSubagent(
              instrumented,
              briefs[briefKey],
              ctx,
              actions,
              () => {}
            );

            handoff = trace.handoffText || result.text || '';
            systemPrompt = result.systemPrompt;
            history = result.history;

            // Save the generated image(s) from mock store.
            for (const imageId of result.imageIds) {
              const entry = stores.images.get(imageId);
              if (entry?.blob) {
                const buffer = Buffer.from(await entry.blob.arrayBuffer());
                const filename = `${briefKey}_${variantKey}${fileSuffix}.png`;
                writeFileSync(join(outDir, filename), buffer);

                results.push({
                  variant: variantKey,
                  brief: briefKey,
                  attempt,
                  filename,
                  prompt: trace.generations[trace.generations.length - 1]?.prompt ?? '',
                  handoff,
                });
              }
            }
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            results.push({
              variant: variantKey,
              brief: briefKey,
              attempt,
              filename: '',
              prompt: trace.generations[trace.generations.length - 1]?.prompt ?? '',
              handoff,
              error
            });
          }

          // Save the full context dump for debugging.
          let { text: dumpText } = buildContextDump(systemPrompt, history);
          if (error) dumpText += `\n=== ERROR ===\n\n${error}\n`;
          writeFileSync(join(outDir, `${briefKey}_${variantKey}${fileSuffix}.txt`), dumpText, 'utf-8');

          // Update comparison page after each run.
          writeComparisonPage(outDir, results);
        });
      }
    }
  }
});

// ── HTML comparison page ──

function writeComparisonPage(
  outDir: string,
  results: Array<{ variant: string; brief: string; attempt: number; filename: string; prompt: string; handoff: string; error?: string }>
) {
  const variants = [...new Set(results.map(r => r.variant))];
  const briefList = [...new Set(results.map(r => r.brief))];

  const rows = briefList.map(brief => {
    const cells = variants.map(variant => {
      const matches = results.filter(r => r.brief === brief && r.variant === variant);
      if (matches.length === 0) return '<td class="pending">pending</td>';

      const images = matches.map(r => {
        if (r.error) return `<div class="attempt error">Error: ${esc(r.error)}</div>`;
        if (!r.filename) return '<div class="attempt error">No image generated</div>';
        return `<div class="attempt">
          <img src="${r.filename}" onclick="openLightbox(this.src)" />
          <details><summary>prompt</summary><pre>${esc(r.prompt)}</pre></details>
        </div>`;
      }).join('\n');

      return `<td>${images}</td>`;
    }).join('\n');
    return `<tr><th>${brief}</th>${cells}</tr>`;
  }).join('\n');

  const headerCells = variants.map(v => `<th>${v}</th>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>TTI Prompt Strategy Comparison</title>
<style>
  body { font-family: system-ui; background: #1a1a2e; color: #e0e0e0; padding: 2rem; }
  h1 { margin-bottom: 0.5rem; }
  p.subtitle { color: #888; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #333; padding: 0.75rem; vertical-align: top; text-align: center; }
  th { background: #252540; position: sticky; top: 0; z-index: 1; }
  tr > th:first-child { position: sticky; left: 0; z-index: 2; }
  img { max-width: 100%; border-radius: 4px; cursor: pointer; transition: opacity 0.15s; }
  img:hover { opacity: 0.85; }
  .attempt { margin-bottom: 0.75rem; }
  .attempt:last-child { margin-bottom: 0; }
  pre { text-align: left; font-size: 0.7rem; white-space: pre-wrap; max-width: 480px; color: #aaa; }
  details { margin-top: 0.25rem; }
  summary { cursor: pointer; color: #a89eed; font-size: 0.75rem; }
  .pending { color: #666; font-style: italic; }
  .error { color: #e55; font-size: 0.85rem; }

  #lightbox {
    display: none; position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,0.92); cursor: pointer;
    justify-content: center; align-items: center;
  }
  #lightbox.open { display: flex; }
  #lightbox img {
    max-width: 95vw; max-height: 95vh; object-fit: contain;
    border-radius: 4px; cursor: default;
  }
</style>
</head>
<body>
<h1>TTI Prompt Strategy Comparison</h1>
<p class="subtitle">${briefList.length} briefs, ${variants.length} variants, ${ATTEMPTS} attempt(s) each. Click any image to view full size.</p>
<table>
<tr><th>Brief</th>${headerCells}</tr>
${rows}
</table>

<div id="lightbox" onclick="closeLightbox()">
  <img id="lightbox-img" onclick="event.stopPropagation()" />
</div>

<script>
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightbox-img').src = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
</script>
</body>
</html>`;

  writeFileSync(join(outDir, 'comparison.html'), html);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
