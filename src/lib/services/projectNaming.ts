/**
 * Auto-naming for projects.
 *
 * Fires a one-shot structured LLM call to infer a project name and
 * description from conversation context. Triggered by the first artifact
 * generation or after N user messages, whichever comes first.
 */
import { Type } from '@google/genai';
import { generateStructuredJson } from '$lib/engine/gemini';
import { TEXT_MODEL } from '$lib/types/schema';
import type { Project, ChatMessage } from '$lib/types/schema';

// ── Constants ──

const USER_MESSAGE_THRESHOLD = 5;
const MAX_CONTEXT_CHARS = 2000;
const MAX_ASSISTANT_CHARS = 200;

const SYSTEM_PROMPT = `You are naming a creative project based on the conversation so far.
Infer a short, evocative project name (2-5 words) and a one-sentence description of the creative direction.
The name should reflect the specific creative vision, not be generic like "Creative Project" or "Art Exploration".
The description should capture the goal or aesthetic, not summarize the conversation.`;

const NAMING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING, description: 'Short project name, 2-5 words.' },
    description: { type: Type.STRING, description: 'One-sentence project description.' }
  },
  required: ['name', 'description']
};

// ── State ──

let namingInFlight = false;

// ── Helpers ──

function isSystemNotice(text: string): boolean {
  const t = text.trim();
  return t.startsWith('<system-notice>') && t.endsWith('</system-notice>');
}

/** Build a compact conversation summary for the naming prompt. */
function buildContext(messages: ChatMessage[]): string {
  let context = '';
  for (const m of messages) {
    if (isSystemNotice(m.text)) continue;
    const prefix = m.role === 'user' ? 'User' : 'Assistant';
    const text = m.role === 'assistant' && m.text.length > MAX_ASSISTANT_CHARS
      ? m.text.slice(0, MAX_ASSISTANT_CHARS) + '...'
      : m.text;
    context += `${prefix}: ${text}\n\n`;
    if (context.length > MAX_CONTEXT_CHARS) break;
  }
  return context.slice(0, MAX_CONTEXT_CHARS);
}

// ── Public API ──

export interface NamingOptions {
  apiKey: string;
  project: Project;
  messages: ChatMessage[];
  hasNewImages: boolean;
  onNamed: (name: string, description: string) => void;
}

/**
 * Check trigger conditions and fire the naming call if appropriate.
 * Returns immediately (fire-and-forget). On failure, resets so the
 * next call can retry.
 */
export function maybeNameProject(opts: NamingOptions): void {
  const { apiKey, project, messages, hasNewImages, onNamed } = opts;

  // Already initialized or in flight.
  if (project.initialized !== false) return;
  if (namingInFlight) return;

  // Trigger: first artifact or N user messages.
  const userMessageCount = messages.filter(m => m.role === 'user' && !isSystemNotice(m.text)).length;
  if (!hasNewImages && userMessageCount < USER_MESSAGE_THRESHOLD) return;

  const context = buildContext(messages);
  if (!context.trim()) return;

  namingInFlight = true;

  generateStructuredJson<{ name: string; description: string }>(
    apiKey,
    TEXT_MODEL,
    `Conversation:\n${context}`,
    NAMING_SCHEMA,
    SYSTEM_PROMPT
  )
    .then(result => {
      if (result.name?.trim()) {
        onNamed(result.name.trim(), (result.description ?? '').trim());
      }
    })
    .catch(() => {
      // Silent failure. namingInFlight resets so next trigger retries.
    })
    .finally(() => {
      namingInFlight = false;
    });
}
