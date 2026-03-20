/**
 * Orchestrator turn harness.
 *
 * Runs the orchestrator's turn loop: send user message, stream response,
 * execute tool calls (including subagent dispatches), repeat. The
 * orchestrator agent definition lives in agents/orchestrator.ts; this
 * module is the execution engine that drives it.
 *
 * No direct database dependencies. All state arrives via TurnContext,
 * all side effects go through TurnActions.
 */
import { ThinkingLevel, type Content, type FunctionCall, type Part } from '@google/genai';
import { sendMessageStreaming } from './gemini';
import { blobToBase64 } from '$lib/utils';
import { functionResponsePart } from './tools';
import { getOrchestratorAgent } from './agents/orchestrator';
import type {
  EngineEvent,
  EventCallback,
  TurnContext,
  TurnActions,
  TurnResult,
  SubagentSessionRecord,
  UserAttachment,
  ToolExecResult,
  ToolHandler
} from './types';

// Re-export types so consumers can import from this module.
export type {
  EngineEvent,
  EventCallback,
  TurnContext,
  TurnActions,
  TurnResult,
  SubagentSessionRecord,
  UserAttachment
};

// Re-export so the context tab can reconstruct the orchestrator's system prompt.
export { buildOrchestratorPrompt } from './agents/orchestrator';

// ── Constants ──

/** Maximum tool-call rounds before we force a stop. */
const MAX_TOOL_ROUNDS = 10;

/**
 * Maximum function calls to execute per round. Gemini 3 models have a
 * server-side bug (Google issue #1275) where 3+ parallel function calls
 * in a single response can produce missing thoughtSignature parts, which
 * corrupts the curated history and causes 400 errors on subsequent turns.
 * Capping at 2 avoids the bug; excess calls get an error response asking
 * the model to retry them in the next round.
 */
const MAX_PARALLEL_CALLS = 2;

/**
 * Debug fault injection. When set to a round number (0-indexed), the
 * harness throws a simulated error at the start of that round.
 * Resets to null after firing.
 */
let _debugFaultRound: number | null = null;

export function debugInjectFault(round: number): void {
  if (!import.meta.env.DEV) return;
  _debugFaultRound = round;
}

// ── Helpers ──

/** Replace a base64 string with a size placeholder. */
function redactBase64(data: string, mimeType?: string): string {
  const kb = Math.ceil((data.length * 3) / 4 / 1024);
  return `[${kb}KB ${mimeType ?? 'binary'}]`;
}

/** Replace binary data with size placeholders for debug logging. */
function redactParts(parts: Part[]): unknown[] {
  return parts.map((p) => {
    if ('inlineData' in p && p.inlineData) {
      return { inlineData: { mimeType: p.inlineData.mimeType, data: redactBase64(p.inlineData.data ?? '', p.inlineData.mimeType) } };
    }
    if ('functionResponse' in p && p.functionResponse) {
      const fr = p.functionResponse as Record<string, unknown>;
      const redacted: Record<string, unknown> = { name: p.functionResponse.name, id: p.functionResponse.id, response: p.functionResponse.response };
      if (Array.isArray(fr.parts)) {
        redacted.parts = redactParts(fr.parts as Part[]);
      }
      return { functionResponse: redacted };
    }
    return p;
  });
}

/** Store attachments and encode them as inline data parts for the API. */
async function processAttachments(
  attachments: UserAttachment[],
  actions: TurnActions
): Promise<{ ids: string[]; parts: Part[] }> {
  const results = await Promise.all(
    attachments.map(async (attachment) => {
      const [stored, base64] = await Promise.all([
        actions.createImage(attachment.blob, attachment.label, { source: 'user' }),
        blobToBase64(attachment.blob)
      ]);
      return {
        id: stored.id,
        part: { inlineData: { data: base64, mimeType: attachment.blob.type || 'image/png' } } as Part
      };
    })
  );
  return { ids: results.map((r) => r.id), parts: results.map((r) => r.part) };
}

/** Append image references like [image:id] to text, if any. */
function appendImageRefs(text: string, imageIds: string[]): string {
  if (imageIds.length === 0) return text;
  const refs = imageIds.map((id) => `[image:${id}]`).join(' ');
  return `${text}\n\n${refs}`;
}

// ── Tool execution ──

async function executeToolCall(
  call: FunctionCall,
  toolHandlers: Record<string, ToolHandler>,
  ctx: TurnContext,
  actions: TurnActions,
  onEvent: EventCallback
): Promise<ToolExecResult> {
  const name = call.name ?? 'unknown';
  const id = call.id;
  const args = call.args ?? {};
  const handler = toolHandlers[name];

  if (!handler) {
    return { responseParts: [functionResponsePart(name, id, { error: `Unknown tool: ${name}` })] };
  }

  return handler(name, id, args as Record<string, unknown>, ctx, actions, onEvent);
}

// ── Main turn loop ──

let turnInProgress = false;

/**
 * Execute a single agent turn: send the user's message, handle any tool-call
 * rounds, and return everything the caller needs to persist on the agent session.
 *
 * On error, returns partial results with history rolled back to its
 * pre-turn state so the session can safely continue.
 *
 * @param reattachImageIds - Image IDs from a previous failed turn to re-send
 *   as inline data without re-storing them.
 */
export async function runAgentTurn(
  ctx: TurnContext,
  actions: TurnActions,
  userText: string,
  onEvent: EventCallback,
  attachments: UserAttachment[] = [],
  reattachImageIds: string[] = []
): Promise<TurnResult> {
  if (turnInProgress) {
    onEvent({ type: 'error', message: 'A turn is already in progress.' });
    return { userText: '', userImageIds: [], assistantText: '', assistantImageIds: [], apiHistory: ctx.apiHistory, systemPrompt: '', subagentSessions: [] };
  }
  turnInProgress = true;

  try {
    return await runAgentTurnInner(ctx, actions, userText, onEvent, attachments, reattachImageIds);
  } finally {
    turnInProgress = false;
  }
}

async function runAgentTurnInner(
  ctx: TurnContext,
  actions: TurnActions,
  userText: string,
  onEvent: EventCallback,
  attachments: UserAttachment[],
  reattachImageIds: string[]
): Promise<TurnResult> {
  if (!ctx.apiKey) {
    onEvent({ type: 'error', message: 'No API key configured. Add your Gemini API key in settings.' });
    return { userText: '', userImageIds: [], assistantText: '', assistantImageIds: [], apiHistory: ctx.apiHistory, systemPrompt: '', subagentSessions: [] };
  }

  // Build the agent definition from current project state.
  const agent = getOrchestratorAgent(
    ctx.projectName, ctx.agentMemories, ctx.projectImages, ctx.favoriteImages,
    ctx.totalMemoryCount, ctx.totalImageCount
  );
  const { systemPrompt, toolDeclarations, toolHandlers } = agent;

  onEvent({ type: 'debug_system_prompt', prompt: systemPrompt });

  const config = {
    systemInstruction: systemPrompt,
    tools: [{ functionDeclarations: toolDeclarations }],
    // LOW thinking: enough for tool-call reasoning without burning tokens on reflection.
    thinkingConfig: { includeThoughts: true, thinkingLevel: ThinkingLevel.LOW }
  };

  let apiHistory = ctx.apiHistory;
  let accumulatedText = '';
  const generatedImageIds: string[] = [];
  const subagentSessions: SubagentSessionRecord[] = [];
  let userImageIds: string[] = [];

  try {
    const attachmentResult = await processAttachments(attachments, actions);
    userImageIds = attachmentResult.ids;

    // Re-attach images from a previous failed turn (already stored, just need inline data).
    const reattachParts: Part[] = [];
    for (const imageId of reattachImageIds) {
      const img = await actions.getImage(imageId);
      if (img) {
        const base64 = await blobToBase64(img.blob);
        reattachParts.push({ inlineData: { data: base64, mimeType: img.mimeType } });
        userImageIds.push(imageId);
      }
    }
    if (reattachImageIds.length > 0) {
      await actions.touchImages(reattachImageIds);
    }

    // First iteration: user message + attachments. Subsequent iterations: tool response parts.
    let currentParts: Part[] = [{ text: userText }, ...attachmentResult.parts, ...reattachParts];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (_debugFaultRound !== null && round === _debugFaultRound) {
        _debugFaultRound = null;
        throw new Error(`[simulated] Fault injected on round ${round}`);
      }

      onEvent({ type: 'status', text: round === 0 ? 'Thinking...' : 'Processing tool results...' });
      onEvent({ type: 'debug_request', round, parts: redactParts(currentParts), historyLength: apiHistory.length });

      if (ctx.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');

      const { stream, getResult } = await sendMessageStreaming(
        ctx.apiKey,
        ctx.textModel,
        currentParts,
        apiHistory,
        config,
        ctx.signal
      );

      let roundText = '';
      let roundThought = '';
      const debugFunctionCalls: { name: string; args: unknown }[] = [];

      for await (const chunk of stream) {
        if (chunk.textDelta) {
          roundText += chunk.textDelta;
          onEvent({ type: 'text_delta', text: chunk.textDelta });
        }
        if (chunk.thoughtDelta) {
          roundThought += chunk.thoughtDelta;
          onEvent({ type: 'thought_delta', text: chunk.thoughtDelta });
        }
        if (chunk.functionCalls) {
          for (const fc of chunk.functionCalls) {
            debugFunctionCalls.push({ name: fc.name ?? 'unknown', args: fc.args });
          }
        }
      }

      if (roundThought) {
        onEvent({ type: 'debug_thought', round, text: roundThought });
      }

      const result = getResult();
      apiHistory = result.history;

      onEvent({ type: 'debug_response', round, text: result.text, functionCalls: debugFunctionCalls });

      if (roundText) {
        accumulatedText += (accumulatedText ? '\n\n' : '') + roundText;
      }

      if (result.functionCalls.length === 0) break;

      // On the final round, skip tool execution rather than executing
      // side effects the model will never see the results of.
      if (round === MAX_TOOL_ROUNDS - 1) {
        onEvent({ type: 'error', message: `Agent stopped after ${MAX_TOOL_ROUNDS} rounds. Remaining tool calls were not executed.` });
        break;
      }

      // Execute function calls and collect response parts.
      const responseParts: Part[] = [];

      for (let i = 0; i < result.functionCalls.length; i++) {
        const call = result.functionCalls[i];
        if (ctx.signal?.aborted) throw new DOMException('Turn cancelled', 'AbortError');

        // Defer excess calls to avoid the 3+ parallel call thoughtSignature bug.
        if (i >= MAX_PARALLEL_CALLS) {
          const name = call.name ?? 'unknown';
          responseParts.push(functionResponsePart(name, call.id, {
            error: 'Too many parallel tool calls. Please call this tool again.'
          }));
          onEvent({ type: 'debug_tool_exec', name, args: { _deferred: true } });
          continue;
        }

        const callArgs = (call.args ?? {}) as Record<string, unknown>;
        onEvent({ type: 'debug_tool_exec', name: call.name ?? 'unknown', args: callArgs });

        const execResult = await executeToolCall(call, toolHandlers, ctx, actions, onEvent);

        onEvent({ type: 'debug_tool_result', name: call.name ?? 'unknown', result: redactParts(execResult.responseParts) });

        if (execResult.imageIds) {
          generatedImageIds.push(...execResult.imageIds);
        } else if (execResult.imageId) {
          generatedImageIds.push(execResult.imageId);
        }
        if (execResult.subagentSession) {
          subagentSessions.push(execResult.subagentSession);
        }
        responseParts.push(...execResult.responseParts);
      }

      currentParts = responseParts;
    }
  } catch (err) {
    const cancelled = err instanceof DOMException && err.name === 'AbortError';
    const msg = cancelled ? 'Turn cancelled' : (err instanceof Error ? err.message : String(err));
    onEvent({ type: 'error', message: cancelled ? msg : `API error: ${msg}` });

    const partialAssistantText = appendImageRefs(accumulatedText, generatedImageIds);
    onEvent({ type: 'done', assistantText: partialAssistantText, imageIds: generatedImageIds });

    return {
      userText: appendImageRefs(userText, userImageIds),
      userImageIds,
      assistantText: partialAssistantText,
      assistantImageIds: generatedImageIds,
      // Always roll back to pre-turn history. Intermediate states contain
      // dangling function calls (no tool responses) that the SDK's history
      // curation can't fix, and that corrupt all subsequent turns.
      apiHistory: ctx.apiHistory,
      systemPrompt,
      subagentSessions,
      error: msg
    };
  }

  const finalAssistantText = appendImageRefs(accumulatedText, generatedImageIds);

  onEvent({ type: 'done', assistantText: finalAssistantText, imageIds: generatedImageIds });

  return {
    userText: appendImageRefs(userText, userImageIds),
    userImageIds,
    assistantText: finalAssistantText,
    assistantImageIds: generatedImageIds,
    apiHistory,
    systemPrompt,
    subagentSessions
  };
}
