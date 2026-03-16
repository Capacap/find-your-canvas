/**
 * Shared types for the engine layer.
 *
 * These are the interfaces that flow between the turn harness, the
 * subagent runner, tool handlers, and agent definitions. Extracted
 * here to keep the dependency graph acyclic.
 */
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import type { AgentMemory, ImageMeta, ImageBlob, ImageSource } from '$lib/types/schema';

/** Events emitted by the engine to the UI during a turn. */
export type EngineEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'image_generating'; label: string }
  | { type: 'image_complete'; imageId: string; label: string }
  | { type: 'image_viewing'; imageIds: string[]; reason?: string }
  | { type: 'memory_updated'; slug: string }
  | { type: 'subagent_start'; agentType: string; dispatchId: string }
  | { type: 'subagent_end'; agentType: string; dispatchId: string; imageIds: string[] }
  | { type: 'error'; message: string }
  | { type: 'done'; assistantText: string; imageIds: string[] }
  | { type: 'debug_system_prompt'; prompt: string }
  | { type: 'debug_request'; round: number; parts: unknown[]; historyLength: number }
  | { type: 'debug_response'; round: number; text: string; functionCalls: unknown[] }
  | { type: 'debug_tool_exec'; name: string; args: Record<string, unknown> }
  | { type: 'debug_tool_result'; name: string; result: unknown }
  | { type: 'debug_thought'; round: number; text: string }
  | { type: 'debug_turn_boundary'; timestamp: number };

export type EventCallback = (event: EngineEvent) => void;

/** Pre-fetched context for an agent turn. */
export interface TurnContext {
  apiKey: string;
  textModel: string;
  imageModel: string;
  projectName: string;
  agentMemories: AgentMemory[];
  projectImages: ImageMeta[];
  /** Raw Gemini history from the agent session. */
  apiHistory: Content[];
  /** Signal to abort the turn. Checked between rounds and passed to API calls. */
  signal?: AbortSignal;
}

/** Side effects agents can perform during tool execution. */
export interface TurnActions {
  createImage(blob: Blob, label: string, opts?: { source?: ImageSource; generationContext?: string }): Promise<ImageMeta>;
  getImage(id: string): Promise<(ImageMeta & ImageBlob) | undefined>;
  getImageThumbnail(id: string): Promise<{ base64: string; mimeType: string } | undefined>;
  getAgentMemory(slug: string): Promise<AgentMemory | undefined>;
  listAgentMemories(): Promise<AgentMemory[]>;
  upsertAgentMemory(slug: string, title: string, summary: string, content: string): Promise<void>;
}

/** What the caller needs to persist after a turn completes. */
export interface TurnResult {
  userText: string;
  userImageIds: string[];
  assistantText: string;
  assistantImageIds: string[];
  /** Updated Gemini history including this turn, for storage on the agent session. */
  apiHistory: Content[];
  /** Snapshot of the system prompt used for this turn. */
  systemPrompt: string;
  /** Subagent sessions spawned during this turn, for the caller to persist. */
  subagentSessions: SubagentSessionRecord[];
  /** If set, the turn ended due to an error. Partial results above should still be persisted. */
  error?: string;
}

/** A subagent session to persist after a turn. */
export interface SubagentSessionRecord {
  agentType: 'text-to-image' | 'image-to-image';
  dispatchId: string;
  systemPrompt: string;
  history: Content[];
}

export interface UserAttachment {
  blob: Blob;
  label: string;
}

// ── Tool types ──

export interface ToolExecResult {
  /** Parts to send back as the function response. */
  responseParts: Part[];
  /** If this tool call produced a new image, its ID. */
  imageId?: string;
  /** If this tool call produced multiple images, their IDs. Takes precedence over imageId. */
  imageIds?: string[];
  /** If true, the agent should stop looping (subagent handoff). */
  handoff?: boolean;
  /** Text payload from a handoff tool. */
  handoffText?: string;
  /** If this tool call spawned a subagent, its session record for persistence. */
  subagentSession?: SubagentSessionRecord;
}

export type ToolHandler = (
  toolName: string,
  callId: string | undefined,
  args: Record<string, unknown>,
  ctx: TurnContext,
  actions: TurnActions,
  onEvent: EventCallback
) => Promise<ToolExecResult>;

/** An agent's prompt, tool declarations, and tool handler map. */
export interface AgentDefinition {
  systemPrompt: string;
  toolDeclarations: FunctionDeclaration[];
  toolHandlers: Record<string, ToolHandler>;
}
