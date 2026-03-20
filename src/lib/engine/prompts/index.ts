/**
 * Prompt assembly.
 *
 * Section files in ./sections/ are atomic prompt components, each covering
 * one concern. This module imports them at build time (Vite ?raw), assembles
 * them into per-agent templates, and exports the same interface the agent
 * definitions consume: template strings with {{variable}} placeholders,
 * plus utilities for building dynamic sections (memory, images).
 *
 * To change a shared behavior (e.g., content filter guidance), edit the
 * shared section file. To A/B test a section, swap it in the assembly below.
 */

import type { ImageMeta } from '$lib/types/schema';

// ── Shared sections ──

import contentFilter from './sections/content-filter.txt?raw';
import referenceImages from './sections/reference-images.txt?raw';
import specialistConfidence from './sections/specialist-confidence.txt?raw';

// ── Orchestrator sections ──

import orchestratorIdentity from './sections/orchestrator-identity.txt?raw';
import orchestratorIntent from './sections/orchestrator-intent.txt?raw';
import orchestratorGuidance from './sections/orchestrator-guidance.txt?raw';
import orchestratorDispatching from './sections/orchestrator-dispatching.txt?raw';
import orchestratorPostGeneration from './sections/orchestrator-post-generation.txt?raw';
import orchestratorMemory from './sections/orchestrator-memory.txt?raw';
import orchestratorVoice from './sections/orchestrator-voice.txt?raw';
import orchestratorSuggestedReplies from './sections/orchestrator-suggested-replies.txt?raw';

// ── Text-to-image sections ──

import ttiIdentity from './sections/tti-identity.txt?raw';
import ttiPrompts from './sections/tti-prompts.txt?raw';

// ── Image-to-image sections ──

import itiIdentity from './sections/iti-identity.txt?raw';
import itiTransformation from './sections/iti-transformation.txt?raw';

// ── Dynamic section templates ──

import memoryIndexTemplate from './memory-index.txt?raw';
import memoryEmptyTemplate from './memory-empty.txt?raw';

// ── Assembly ──

function assemble(...sections: string[]): string {
  return sections.map((s) => s.trim()).join('\n\n');
}

const orchestratorTemplate = assemble(
  orchestratorIdentity,
  orchestratorIntent,
  orchestratorGuidance,
  orchestratorDispatching,
  orchestratorPostGeneration,
  orchestratorMemory,
  contentFilter,
  orchestratorVoice,
  orchestratorSuggestedReplies,
  '{{memorySection}}',
  '{{imageIndexSection}}'
);

const textToImageTemplate = assemble(
  ttiIdentity,
  specialistConfidence,
  ttiPrompts,
  referenceImages,
  contentFilter,
  '{{memorySection}}',
  '{{imageIndexSection}}'
);

const imageToImageTemplate = assemble(
  itiIdentity,
  specialistConfidence,
  itiTransformation,
  referenceImages,
  contentFilter,
  '{{memorySection}}',
  '{{imageIndexSection}}'
);

// ── Interpolation ──

/** Replace {{key}} placeholders with values from the provided map. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// ── Dynamic section builders ──

/** Render the memory index table for injection into agent prompts.
 *  Wrapped in <project-memory> to separate dynamic context from static instructions. */
function buildMemorySection(
  topics: { slug: string; title: string; summary: string }[],
  totalCount?: number
): string {
  if (topics.length === 0) return `<project-memory>\n${memoryEmptyTemplate}\n</project-memory>`;
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
  return `<project-memory>\n${section}\n</project-memory>`;
}

/** Format a single image entry for the index. */
function formatImageEntry(img: ImageMeta): string {
  const source = img.source === 'user' ? 'user_uploaded' : 'generated';
  const fields: string[] = [`id: ${img.id}`, `source: ${source}`];
  if (img.generationContext) {
    const genCtx = img.generationContext;
    fields.push(`prompt: "${genCtx.length > 120 ? genCtx.slice(0, 120) + '...' : genCtx}"`);
  }
  return `- ${img.label} - { ${fields.join(', ')} }`;
}

/** Render the image index for injection into agent prompts.
 *  Favorites and recent images are separate sections with independent purposes.
 *  Wrapped in <project-images> to separate dynamic context from static instructions. */
function buildImageIndex(images: ImageMeta[], favorites: ImageMeta[], totalCount?: number): string {
  if (images.length === 0 && favorites.length === 0) {
    return '<project-images>\n## Project Images\n\nNo images in this project yet.\n</project-images>';
  }

  const total = totalCount ?? images.length;
  const truncated = total > images.length;
  const lines: string[] = ['## Project Images'];

  if (favorites.length > 0) {
    lines.push('');
    lines.push('<favorite-images>');
    lines.push('The user has endorsed these images as high-quality results. Prefer these as style references when they are visually relevant to the task.');
    lines.push('');
    for (const img of favorites) lines.push(formatImageEntry(img));
    lines.push('</favorite-images>');
  }

  lines.push('');
  lines.push('<recent-images>');
  lines.push(
    truncated
      ? 'Ordered by most recently used. Use `view_images` to examine any image before referencing it. Use `search_images` to find images not listed here.'
      : 'Use `view_images` to examine any image before referencing it.'
  );
  lines.push('');
  for (const img of images) lines.push(formatImageEntry(img));

  if (truncated) {
    lines.push('');
    lines.push(`*Showing ${images.length} most recently used of ${total} total images. Use \`search_images\` to find others.*`);
  }
  lines.push('</recent-images>');

  return `<project-images>\n${lines.join('\n')}\n</project-images>`;
}

// ── Exports ──

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
