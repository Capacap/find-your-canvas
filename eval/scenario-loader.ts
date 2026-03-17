/**
 * Loads eval scenarios from JSON files and hydrates them into
 * typed objects ready for the eval runners.
 *
 * Scenario files live under eval/scenarios/{orchestrator,specialist}/.
 * Each JSON file defines one scenario: the prompt, optional memories
 * and images (with inline base64 data), and success criteria for
 * future LLM-as-judge evaluation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMemory, ImageMeta } from '$lib/types/schema';

// ── Scenario file types (what lives on disk) ──

interface ScenarioImageJson {
  id: string;
  source: 'user' | 'generated';
  mimeType: string;
  label: string;
  generationContext?: string;
  /** Base64-encoded image data. Hydrated to Blob at load time. */
  data: string;
}

interface ScenarioMemoryJson {
  slug: string;
  title: string;
  summary: string;
  content: string;
}

interface ScenarioJson {
  name: string;
  agent: 'orchestrator' | 'text-to-image' | 'image-to-image';
  /** User message (orchestrator) or dispatch brief (specialist). */
  prompt: string;
  /** Desired agent behavior, for LLM-as-judge evaluation. */
  successCriteria?: string;
  memories?: ScenarioMemoryJson[];
  images?: ScenarioImageJson[];
}

// ── Hydrated types (what the eval runners consume) ──

export interface Scenario {
  name: string;
  agent: 'orchestrator' | 'text-to-image' | 'image-to-image';
  prompt: string;
  successCriteria?: string;
  memories: AgentMemory[];
  images: ImageMeta[];
}

// ── Hydration ──

function hydrateMemory(scenarioName: string, m: ScenarioMemoryJson): AgentMemory {
  const now = Date.now();
  return {
    id: `eval-${scenarioName}-${m.slug}`,
    projectId: 'eval-project',
    slug: m.slug,
    title: m.title,
    summary: m.summary,
    content: m.content,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now
  };
}

function hydrateImage(img: ScenarioImageJson): ImageMeta {
  const now = Date.now();
  const blob = new Blob([Buffer.from(img.data, 'base64')], { type: img.mimeType });
  return {
    id: img.id,
    projectId: 'eval-project',
    source: img.source,
    mimeType: img.mimeType,
    label: img.label,
    generationContext: img.generationContext,
    thumbnail: blob,
    createdAt: now,
    lastAccessedAt: now
  };
}

function hydrateScenario(raw: ScenarioJson): Scenario {
  return {
    name: raw.name,
    agent: raw.agent,
    prompt: raw.prompt,
    successCriteria: raw.successCriteria,
    memories: (raw.memories ?? []).map(m => hydrateMemory(raw.name, m)),
    images: (raw.images ?? []).map(hydrateImage)
  };
}

// ── Utilities ──

/** Convert a scenario name to a filesystem-safe slug. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
}

// ── Loader ──

function loadScenariosFromDir(dir: string): Scenario[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      let raw: ScenarioJson;
      try {
        raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      } catch (err) {
        throw new Error(`Failed to load scenario ${f}: ${(err as Error).message}`);
      }
      return hydrateScenario(raw);
    });
}

/** Load all scenarios for a given agent category. */
export function loadScenarios(category: 'orchestrator' | 'specialist'): Scenario[] {
  const dir = join(import.meta.dirname, 'scenarios', category);
  return loadScenariosFromDir(dir);
}
