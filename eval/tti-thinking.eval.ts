/**
 * TTI thinking level comparison.
 *
 * Sends identical prompts to the image model with LOW vs HIGH thinking.
 * Bypasses the specialist agent to isolate the thinking variable.
 *
 * Run:  GEMINI_API_KEY=... pnpm eval:tti-think
 *
 * Output: eval/traces/{timestamp}/tti-thinking/ with images and
 * comparison.html for visual evaluation.
 */
import { describe, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ThinkingLevel } from '@google/genai';
import { generateImage } from '$lib/engine/gemini';
import { IMAGE_MODEL } from '$lib/types/schema';
import { getRunDir } from './run-dir';

const ATTEMPTS = Number(process.env.TTI_ATTEMPTS ?? 3);

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

// ── Fixed prompts (minimal specsheet style) ──

const prompts: Record<string, { prompt: string; aspectRatio: string }> = {
  cave: {
    prompt: [
      'Subject: An abandoned Stone Age cave dwelling in a natural limestone cavern.',
      'Composition: Wide angle interior shot looking toward the far wall.',
      'Setting: Cold dead hearth in the center with grey ash and charred wood. Cured animal hides for bedding, crude stone tools, cracked animal bones scattered around.',
      'Lighting: Somber. Faint cold daylight from a distant cave entrance, deep shadows.',
      'Palette: Desaturated earth tones, cold greys, ochre, charcoal.',
      'Style: Gritty digital painting with visible brushstrokes, heavy atmospheric contrast.',
      'Mood: Eerie, still, abandoned.',
      'Details: On the far wall, ochre and charcoal handprints of adults and children overlapping a faded hunting mural of a massive rhinoceros.'
    ].join('\n'),
    aspectRatio: '16:9'
  },

  elder_portrait: {
    prompt: [
      'Subject: Close-up portrait of a Stone Age tribal elder.',
      'Composition: Head and shoulders, slight three-quarter angle.',
      'Setting: Out of focus warm interior, firelight.',
      'Lighting: Warm directional firelight from below-left, deep shadows on the right side of the face.',
      'Palette: Warm amber, deep brown, dark shadow.',
      'Style: Gritty digital painting, tight brushwork on skin, looser strokes in background.',
      'Mood: Weathered intelligence, wariness.',
      'Details: Deep-set eyes, ritual scarring in geometric lines across cheekbones, necklace of animal teeth and carved bone beads, grey-streaked hair bound with sinew.'
    ].join('\n'),
    aspectRatio: '3:4'
  },

  ritual_site: {
    prompt: [
      'Subject: A Stone Age ritual site at night.',
      'Composition: Wide shot from ground level outside the stone circle, looking in.',
      'Setting: Circle of tall rough-hewn standing stones on a hilltop, weathered and lichen-covered.',
      'Lighting: Large bonfire in the center throws shifting orange light across the inner faces of the stones. Sparks drift upward. No other light source.',
      'Palette: Deep blue-black sky, warm orange fire, cool grey stones. Sharp stars visible above.',
      'Style: Gritty painterly digital art with heavy atmospheric effects, smoke and firelight haze.',
      'Mood: Ceremonial, ancient, contained warmth against vast dark.',
      'Details: Several small human silhouettes stand around the fire in ceremonial postures.'
    ].join('\n'),
    aspectRatio: '21:9'
  },

  migration: {
    prompt: [
      'Subject: A Stone Age group crossing a wide shallow river ford.',
      'Composition: Mid-distance side view showing the line of figures crossing.',
      'Setting: Wide knee-deep river with clear water over a gravel bed. Far bank rises into birch forest with autumn foliage.',
      'Lighting: Overcast daylight, soft and even. Reflections in the shallow water.',
      'Palette: Desaturated earth tones with muted gold and orange autumn color.',
      'Style: Gritty concept art, painterly with visible brushstrokes.',
      'Mood: Collective effort, weary movement.',
      'Details: Eight to twelve figures with distinct postures. Adults carry bundles and tools. One carries a child on shoulders. A dog wades alongside.'
    ].join('\n'),
    aspectRatio: '21:9'
  },

  predator_night: {
    prompt: [
      'Subject: A Stone Age camp at night with a predator at the edge of firelight.',
      'Composition: Low wide shot centered on the small campfire.',
      'Setting: Forest clearing at night. Small campfire, two figures huddled near it.',
      'Lighting: Campfire is the only light source. Abrupt transition from warm amber to near-black.',
      'Palette: Warm amber in the fire circle, near-black everywhere else.',
      'Style: Gritty digital painting, heavy use of shadow.',
      'Mood: Tense, vulnerable, isolated.',
      'Details: One figure grips a spear, both looking outward. Just beyond the firelight: reflective eyes and partial silhouette of a large cave hyena, mostly swallowed by darkness.'
    ].join('\n'),
    aspectRatio: '16:9'
  }
};

// ── Thinking levels to compare ──

const thinkingLevels = {
  minimal: ThinkingLevel.MINIMAL,
  high: ThinkingLevel.HIGH
};

// ── Runner ──

const promptKeys = Object.keys(prompts);
const levelKeys = Object.keys(thinkingLevels) as Array<keyof typeof thinkingLevels>;

describe.skipIf(!apiKey)('TTI thinking level comparison', () => {
  const outDir = join(getRunDir(), 'tti-thinking');
  mkdirSync(outDir, { recursive: true });

  const results: Array<{
    level: string;
    brief: string;
    attempt: number;
    filename: string;
    error?: string;
  }> = [];

  for (const promptKey of promptKeys) {
    for (const levelKey of levelKeys) {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const suffix = ATTEMPTS > 1 ? ` #${attempt}` : '';
        const testName = `${promptKey} × ${levelKey}${suffix}`;

        it(testName, async () => {
          const { prompt, aspectRatio } = prompts[promptKey];
          const fileSuffix = ATTEMPTS > 1 ? `_${attempt}` : '';
          const filename = `${promptKey}_${levelKey}${fileSuffix}.png`;

          try {
            const result = await generateImage(
              apiKey!,
              IMAGE_MODEL,
              prompt,
              {
                aspectRatio,
                thinkingConfig: {
                  thinkingLevel: thinkingLevels[levelKey],
                  includeThoughts: true
                }
              }
            );

            const buffer = Buffer.from(result.imageData, 'base64');
            writeFileSync(join(outDir, filename), buffer);

            results.push({
              level: levelKey,
              brief: promptKey,
              attempt,
              filename
            });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            results.push({
              level: levelKey,
              brief: promptKey,
              attempt,
              filename: '',
              error
            });
          }

          // Save the prompt for reference (same for both levels).
          writeFileSync(
            join(outDir, `${promptKey}_prompt.txt`),
            prompts[promptKey].prompt,
            'utf-8'
          );

          writeComparisonPage(outDir, results);
        });
      }
    }
  }
});

// ── HTML comparison page ──

function writeComparisonPage(
  outDir: string,
  results: Array<{ level: string; brief: string; attempt: number; filename: string; error?: string }>
) {
  const levels = [...new Set(results.map(r => r.level))];
  const briefList = [...new Set(results.map(r => r.brief))];

  const rows = briefList.map(brief => {
    const cells = levels.map(level => {
      const matches = results.filter(r => r.brief === brief && r.level === level);
      if (matches.length === 0) return '<td class="pending">pending</td>';

      const images = matches.map(r => {
        if (r.error) return `<div class="attempt error">Error: ${esc(r.error)}</div>`;
        if (!r.filename) return '<div class="attempt error">No image generated</div>';
        return `<div class="attempt">
          <img src="${r.filename}" onclick="openLightbox(this.src)" />
        </div>`;
      }).join('\n');

      return `<td>${images}</td>`;
    }).join('\n');
    return `<tr><th>${brief}</th>${cells}</tr>`;
  }).join('\n');

  const headerCells = levels.map(v => `<th>${v}</th>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>TTI Thinking Level Comparison</title>
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
<h1>TTI Thinking Level Comparison</h1>
<p class="subtitle">Identical prompts, different thinking levels. ${ATTEMPTS} attempt(s) each. Click any image to view full size.</p>
<table>
<tr><th>Prompt</th>${headerCells}</tr>
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
