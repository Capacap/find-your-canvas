/**
 * Prompt template loader.
 *
 * Templates are plain text files with {{variable}} placeholders.
 * Vite's ?raw import inlines them at build time, so there's no
 * runtime file I/O and they work in the static SPA build.
 */

import type { ImageMeta } from '$lib/types/schema';

import orchestratorTemplate from './orchestrator.txt?raw';
import textToImageTemplate from './text-to-image.txt?raw';
import imageToImageTemplate from './image-to-image.txt?raw';
import memoryIndexTemplate from './memory-index.txt?raw';
import memoryEmptyTemplate from './memory-empty.txt?raw';

/** Replace {{key}} placeholders with values from the provided map. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

/** Render the memory index table for injection into agent prompts. */
function buildMemorySection(topics: { slug: string; title: string; summary: string }[]): string {
  if (topics.length === 0) return memoryEmptyTemplate;
  const rows = topics.map((t) =>
    `| \`${t.slug}\` | ${t.title} | ${t.summary} |`
  ).join('\n');
  return interpolate(memoryIndexTemplate, { rows });
}

/** Render the image index for injection into agent prompts. */
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

export {
  orchestratorTemplate,
  textToImageTemplate,
  imageToImageTemplate,
  memoryIndexTemplate,
  memoryEmptyTemplate,
  interpolate,
  buildMemorySection,
  buildImageIndex
};
