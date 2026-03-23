/**
 * Generic subagent runner.
 *
 * Runs a mini turn loop for an agent. Takes an AgentDefinition and a
 * dispatch message, then streams through multi-round tool calls until
 * the agent hands off or hits the round limit.
 *
 * Does NOT persist anything. The dispatch handler returns the session
 * record via ToolExecResult.subagentSession, and the turn harness
 * collects it for persistence.
 */
import { ThinkingLevel, type Content, type Part } from '@google/genai';
import { sendMessageStreaming } from './gemini';
import type { AgentDefinition, EventCallback, TurnActions, TurnContext } from './types';
import { functionResponsePart } from './tools';

/** What the subagent runner returns to its caller. */
export interface SubagentResult {
  /** Final text output (from handoff or last model response). */
  text: string;
  /** IDs of images generated during the run. */
  imageIds: string[];
  /** Full Gemini Content[] history for debug persistence. */
  history: Content[];
  /** The system prompt that was used. */
  systemPrompt: string;
}

// ── Constants ──

/** Fewer rounds than the main turn harness; subagents do focused work. */
const MAX_SUBAGENT_ROUNDS = 6;

/** Same parallel call cap as the turn harness (Google issue #1275). */
const MAX_PARALLEL_CALLS = 2;

// ── Runner ──

/**
 * Run a subagent to completion.
 *
 * @param definition - The agent's prompt, tools, and handlers.
 * @param dispatchMessage - The text prompt from the orchestrator's dispatch call.
 * @param ctx - Shared turn context (API key, models, project state).
 * @param actions - Shared side-effect callbacks (image creation, memory access).
 * @param onEvent - Event callback for streaming updates to the UI.
 */
export async function runSubagent(
  definition: AgentDefinition,
  dispatchMessage: string,
  ctx: TurnContext,
  actions: TurnActions,
  onEvent: EventCallback
): Promise<SubagentResult> {
  const config = {
    systemInstruction: definition.systemPrompt,
    tools: [{ functionDeclarations: definition.toolDeclarations }],
    thinkingConfig: { includeThoughts: true, thinkingLevel: ThinkingLevel.LOW }
  };

  let apiHistory: Content[] = [];
  let accumulatedText = '';
  const generatedImageIds: string[] = [];

  let currentParts: Part[] = [{ text: dispatchMessage }];

  for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
    if (ctx.signal?.aborted) throw new DOMException('Subagent cancelled', 'AbortError');

    onEvent({ type: 'status', text: 'Thinking...' });

    const { stream, getResult } = await sendMessageStreaming(
      ctx.apiKey,
      ctx.textModel,
      currentParts,
      apiHistory,
      config,
      ctx.signal
    );

    let roundText = '';
    for await (const chunk of stream) {
      if (chunk.textDelta) {
        roundText += chunk.textDelta;
      }
      // Subagent thoughts and text deltas are not streamed to the UI;
      // the orchestrator only surfaces the final result.
    }

    const result = getResult();
    apiHistory = result.history;

    if (roundText) {
      accumulatedText = roundText; // Keep only the latest round's text.
    }

    if (result.functionCalls.length === 0) break;

    // On the final round, skip tool execution.
    if (round === MAX_SUBAGENT_ROUNDS - 1) break;

    // Execute tool calls.
    const responseParts: Part[] = [];
    let handedOff = false;
    let handoffText = '';

    for (let i = 0; i < result.functionCalls.length; i++) {
      const call = result.functionCalls[i];
      if (ctx.signal?.aborted) throw new DOMException('Subagent cancelled', 'AbortError');

      // Defer excess parallel calls.
      if (i >= MAX_PARALLEL_CALLS) {
        const name = call.name ?? 'unknown';
        responseParts.push(functionResponsePart(name, call.id, {
          error: 'Too many parallel tool calls. Please call this tool again.'
        }));
        continue;
      }

      const name = call.name ?? 'unknown';
      const args = (call.args ?? {}) as Record<string, unknown>;
      const handler = definition.toolHandlers[name];

      if (!handler) {
        responseParts.push(functionResponsePart(name, call.id, { error: `Unknown tool: ${name}` }));
        continue;
      }

      const execResult = await handler(name, call.id, args, ctx, actions, onEvent);

      if (execResult.imageIds) {
        generatedImageIds.push(...execResult.imageIds);
      } else if (execResult.imageId) {
        generatedImageIds.push(execResult.imageId);
      }
      responseParts.push(...execResult.responseParts);

      if (execResult.handoff) {
        handedOff = true;
        handoffText = execResult.handoffText ?? '';
      }
    }

    currentParts = responseParts;

    if (handedOff) {
      // Feed the handoff response back so the model sees it in history,
      // then stop. We need one more sendMessage to close the history properly.
      if (ctx.signal?.aborted) throw new DOMException('Subagent cancelled', 'AbortError');

      const { stream: closeStream, getResult: getCloseResult } = await sendMessageStreaming(
        ctx.apiKey,
        ctx.textModel,
        currentParts,
        apiHistory,
        config,
        ctx.signal
      );
      // Drain the stream.
      for await (const chunk of closeStream) {
        if (chunk.textDelta) {
          handoffText += chunk.textDelta;
        }
      }
      apiHistory = getCloseResult().history;

      return {
        text: handoffText || accumulatedText,
        imageIds: generatedImageIds,
        history: apiHistory,
        systemPrompt: definition.systemPrompt
      };
    }
  }

  // No explicit handoff; synthesize from what the subagent produced.
  return {
    text: accumulatedText,
    imageIds: generatedImageIds,
    history: apiHistory,
    systemPrompt: definition.systemPrompt
  };
}
