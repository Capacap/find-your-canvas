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
function buildMemorySection(
  topics: { slug: string; title: string; summary: string }[],
  totalCount?: number
): string {
  if (topics.length === 0) return memoryEmptyTemplate;
  const total = totalCount ?? topics.length;
  const truncated = total > topics.length;
  const rows = topics.map((t) =>
    `| \`${t.slug}\` | ${t.title} | ${t.summary} |`
  ).join('\n');
  let section = interpolate(memoryIndexTemplate, {
    rows,
    searchHint: truncated ? ' Use `search_memories` to find topics not listed here.' : ''
  });
  if (truncated) {
    section += `\n\n*Showing ${topics.length} most recently used of ${total} total topics. Use \`search_memories\` to find others.*`;
  }
  return section;
}

/** Render the image index for injection into agent prompts.
 *  Includes its own heading and guidance so the section is self-contained. */
function buildImageIndex(images: ImageMeta[], totalCount?: number): string {
  if (images.length === 0) {
    return '## Project Images\n\nNo images in this project yet.';
  }

  const total = totalCount ?? images.length;
  const truncated = total > images.length;

  const lines: string[] = [
    '## Project Images',
    '',
    truncated
      ? 'Ordered by most recently used. Use `view_images` to examine any image before referencing it. Use `search_images` to find images not listed here.'
      : 'Use `view_images` to examine any image before referencing it.',
    ''
  ];

  for (const img of images) {
    const source = img.source === 'user' ? 'user_uploaded' : 'generated';
    const fields: string[] = [`id: ${img.id}`, `source: ${source}`];
    if (img.generationContext) {
      const genCtx = img.generationContext;
      fields.push(`prompt: "${genCtx.length > 120 ? genCtx.slice(0, 120) + '...' : genCtx}"`);
    }
    lines.push(`- ${img.label} - { ${fields.join(', ')} }`);
  }

  if (truncated) {
    lines.push('');
    lines.push(`*Showing ${images.length} most recently used of ${total} total images. Use \`search_images\` to find others.*`);
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
