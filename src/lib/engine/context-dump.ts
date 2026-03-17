/**
 * Renders Gemini Content[] history into a human-readable context dump.
 *
 * Pure functions operating on Content[] arrays with no UI or database
 * dependencies. Used by both the debug interface and the eval harness.
 */
import type { Content } from '@google/genai';

/** Minimal shape for subagent sessions inlined into the dump. */
export interface SubagentSession {
  agentType: string;
  dispatchId?: string;
  systemPrompt: string;
  history: Content[];
}

export interface ContextDumpResult {
  text: string;
  imageCount: number;
  imageTotalKB: number;
}

/** Render a single Part to readable text. Returns null for parts that should be skipped. */
function renderPart(part: any): string | null {
  if (part.functionCall) {
    const name = part.functionCall.name ?? 'unknown';
    const args = part.functionCall.args ?? {};
    return `[Tool Call: ${name}]\n${JSON.stringify(args, null, 2)}`;
  }
  if (part.functionResponse) {
    const name = part.functionResponse.name ?? 'unknown';
    const resp = part.functionResponse.response ?? {};
    const nested = part.functionResponse.parts ?? [];
    const imgCount = nested.filter((p: any) => p.inlineData?.data).length;
    const suffix = imgCount > 0 ? ` (+${imgCount} image${imgCount > 1 ? 's' : ''})` : '';
    return `[Tool Result: ${name}${suffix}]\n${JSON.stringify(resp, null, 2)}`;
  }
  if (part.inlineData?.data) {
    const kb = Math.ceil((part.inlineData.data.length * 3) / 4 / 1024);
    return `[Image: ${part.inlineData.mimeType ?? 'unknown'}, ${kb} KB]`;
  }
  if (part.thought && part.text) return `[Thinking]\n${part.text}`;
  if (part.thoughtSignature) return null;
  if (part.text) return part.text;
  return null;
}

/** Count image data in a Part for the meta summary. */
function countPartImages(part: any): { count: number; kb: number } {
  let count = 0, kb = 0;
  if (part.inlineData?.data) {
    count++;
    kb += Math.ceil((part.inlineData.data.length * 3) / 4 / 1024);
  }
  for (const np of (part.functionResponse?.parts ?? [])) {
    if (np.inlineData?.data) {
      count++;
      kb += Math.ceil((np.inlineData.data.length * 3) / 4 / 1024);
    }
  }
  return { count, kb };
}

/**
 * Determine the display label for a Content entry. The Gemini SDK uses
 * 'user' role for both real user messages and tool-result submissions,
 * so we distinguish based on what parts are present.
 */
function contentLabel(content: Content): string {
  const parts = (content.parts ?? []) as any[];
  const role = content.role ?? 'unknown';
  if (role === 'user' && parts.some((p: any) => p.functionResponse)) return 'TOOL RESULTS';
  if (role === 'model' && parts.some((p: any) => p.functionCall)) return 'TOOL CALLS';
  return role.toUpperCase();
}

function isPlainTextPart(part: any): boolean {
  return !part.functionCall && !part.functionResponse && !part.inlineData
    && !part.thought && !part.thoughtSignature && !!part.text;
}

/**
 * Render a Content[] history into lines, accumulating image stats.
 *
 * The optional afterPart callback fires after each rendered part,
 * receiving the raw part, the output lines array, and a flush function.
 * buildContextDump uses this to insert subagent traces inline.
 */
function renderHistory(
  history: Content[],
  lines: string[],
  imageStats: { count: number; kb: number },
  afterPart?: (part: any, lines: string[], flush: () => void) => void
): void {
  let currentLabel = '';
  let pendingText = '';

  function flushText() {
    if (pendingText) {
      lines.push(pendingText);
      pendingText = '';
    }
  }

  for (const content of history) {
    if (!content.parts || content.parts.length === 0) continue;

    const parts = content.parts as any[];

    for (const part of parts) {
      const imgs = countPartImages(part);
      imageStats.count += imgs.count;
      imageStats.kb += imgs.kb;
    }

    const role = content.role ?? 'unknown';
    const hasNonCallContent = parts.some((p: any) => !p.functionCall && renderPart(p) !== null);
    const hasCalls = parts.some((p: any) => p.functionCall);

    const sections: { label: string; parts: any[] }[] = [];

    if (role === 'model' && hasNonCallContent && hasCalls) {
      sections.push(
        { label: 'MODEL', parts: parts.filter((p: any) => !p.functionCall) },
        { label: 'TOOL CALLS', parts: parts.filter((p: any) => p.functionCall) }
      );
    } else {
      sections.push({ label: contentLabel(content), parts });
    }

    for (const section of sections) {
      const rendered: { part: any; text: string }[] = [];
      for (const part of section.parts) {
        const text = renderPart(part);
        if (text !== null) rendered.push({ part, text });
      }
      if (rendered.length === 0) continue;

      if (section.label !== currentLabel) {
        flushText();
        if (currentLabel) lines.push('');
        lines.push(`--- ${section.label} ---`);
        currentLabel = section.label;
      }

      for (const { part, text } of rendered) {
        if (isPlainTextPart(part)) {
          pendingText += text;
        } else {
          flushText();
          lines.push(text);
        }

        if (afterPart) afterPart(part, lines, flushText);
      }
    }
  }

  flushText();
}

/**
 * Build a full context dump: system instruction followed by rendered
 * history with subagent sessions inlined at their dispatch points.
 */
export function buildContextDump(
  systemPrompt: string,
  history: Content[],
  subagentSessions: SubagentSession[] = []
): ContextDumpResult {
  const lines: string[] = [];
  const imageStats = { count: 0, kb: 0 };

  lines.push('=== SYSTEM INSTRUCTION ===', '', systemPrompt, '');

  const subagentByDispatchId = new Map<string, SubagentSession>();
  for (const sub of subagentSessions) {
    if (sub.dispatchId) {
      subagentByDispatchId.set(sub.dispatchId, sub);
    }
  }

  renderHistory(history, lines, imageStats, (part, lines, flush) => {
    if (!part.functionCall) return;
    const callId = part.functionCall.id;
    const callName = part.functionCall.name ?? '';
    if (!callId || !callName.startsWith('dispatch_') || !subagentByDispatchId.has(callId)) return;

    flush();
    const sub = subagentByDispatchId.get(callId)!;
    lines.push('');
    lines.push(`    ╭── SUBAGENT: ${sub.agentType} (dispatch: ${sub.dispatchId}) ──`);
    lines.push(`    │ System prompt: ${sub.systemPrompt.slice(0, 100)}...`);
    const subLines: string[] = [];
    renderHistory(sub.history, subLines, imageStats);
    for (const sl of subLines) {
      lines.push(`    │ ${sl}`);
    }
    lines.push(`    ╰── END SUBAGENT ──`);
    lines.push('');
  });

  lines.push('');
  return { text: lines.join('\n'), imageCount: imageStats.count, imageTotalKB: imageStats.kb };
}
