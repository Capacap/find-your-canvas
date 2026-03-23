/**
 * Reactive turn state and execution logic.
 *
 * Bridges the orchestration engine with the app store and database layer,
 * keeping the page component free of engine wiring. Owns all state related
 * to a running or recently-completed agent turn: streaming output, status,
 * errors, debug events, retry context, and turn rollback.
 */
import {
  getAppState,
  refreshMessages,
  refreshProjectImages,
  refreshAgentMemories,
  refreshConversation,
  refreshOrchestratorSession
} from './appState.svelte';
import {
  runAgentTurn,
  type EngineEvent,
  type UserAttachment,
  type TurnContext,
  type TurnActions
} from '$lib/engine/turn';
import { TEXT_MODEL, IMAGE_MODEL } from '$lib/types/schema';
import * as ops from '$lib/db/operations';

// ── Reactive turn state ──

interface SubagentStep {
  text: string;
  done: boolean;
}

export interface SubagentProgress {
  agentType: string;
  steps: SubagentStep[];
}

/** A single entry in the chronological activity log shown during a turn. */
export interface ActivityEntry {
  text: string;
  /** Indented entries are subagent child steps. */
  nested: boolean;
}

let isRunning = $state(false);
let streamingText = $state('');
let streamingThought = $state('');
let statusText = $state('');
let errorText = $state('');
let debugEvents = $state<EngineEvent[]>([]);
let retryInput = $state('');
let retryImageIds = $state<string[]>([]);
let subagentProgress = $state<SubagentProgress | null>(null);
let activityLog = $state<ActivityEntry[]>([]);
let abortController: AbortController | null = null;

export function getTurnState() {
  return {
    get isRunning() { return isRunning; },
    get streamingText() { return streamingText; },
    get streamingThought() { return streamingThought; },
    get statusText() { return statusText; },
    get errorText() { return errorText; },
    get debugEvents() { return debugEvents; },
    get retryInput() { return retryInput; },
    get retryImageIds() { return retryImageIds; },
    get subagentProgress() { return subagentProgress; },
    get activityLog() { return activityLog; }
  };
}

/** Reset error and retry state (e.g. on conversation switch). */
export function clearTurnError(): void {
  errorText = '';
  retryInput = '';
  retryImageIds = [];
}

/** Clear the debug event log. */
export function clearDebugLog(): void {
  debugEvents = [];
}

/** Cancel the currently running turn, if any. */
export function cancelTurn(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

// ── Turn execution ──

export interface SendOptions {
  text: string;
  files?: File[];
  reattachImageIds?: string[];
  /** Called when a new image is generated mid-turn, so the UI can resolve its URL. */
  onImageGenerated?: (imageId: string) => void;
}

/**
 * Execute an agent turn. Builds context from current app state,
 * runs the orchestrator, and persists results atomically.
 *
 * Returns false if the turn couldn't start (already running, missing project/conversation).
 */
export async function sendMessage(opts: SendOptions): Promise<boolean> {
  const app = getAppState();
  if (isRunning) return false;
  if (!app.currentProject || !app.currentConversation) return false;

  const projectId = app.currentProject.id;
  const conversationId = app.currentConversation.id;

  // Ensure an orchestrator session exists for this conversation.
  let session = app.orchestratorSession;
  if (!session) {
    session = await ops.createAgentSession(conversationId, 'orchestrator');
  }

  abortController = new AbortController();
  isRunning = true;
  if (debugEvents.length > 0) {
    debugEvents = [...debugEvents, { type: 'debug_turn_boundary' as const, timestamp: Date.now() }];
  }
  streamingText = '';
  streamingThought = '';
  statusText = 'Thinking...';
  errorText = '';
  subagentProgress = null;
  activityLog = [];

  // Clean up any leftover error-turn messages from previous failures.
  await ops.deleteErrorMessages(conversationId);
  await refreshMessages();

  // Fetch MRU-capped artifact lists for the system prompt.
  // Favorites and MRU are separate sections with independent caps.
  const IMAGE_MRU_CAP = 30;
  const FAVORITE_CAP = 20;
  const MEMORY_MRU_CAP = 20;
  const [mruImages, favorites, imageCount, mruMemories, memoryCount] = await Promise.all([
    ops.listImagesMRU(projectId, IMAGE_MRU_CAP),
    ops.listFavoriteImages(projectId, FAVORITE_CAP),
    ops.countImages(projectId),
    ops.listMemoriesMRU(projectId, MEMORY_MRU_CAP),
    ops.countMemories(projectId)
  ]);

  const ctx: TurnContext = {
    apiKey: app.settings?.geminiApiKey ?? '',
    textModel: TEXT_MODEL,
    imageModel: IMAGE_MODEL,
    projectName: app.currentProject.name,
    agentMemories: mruMemories,
    totalMemoryCount: memoryCount,
    projectImages: mruImages,
    favoriteImages: favorites,
    totalImageCount: imageCount,
    apiHistory: $state.snapshot(session.history),
    signal: abortController.signal
  };

  const actions: TurnActions = {
    createImage: (blob, label, actionOpts) => ops.createImage(projectId, blob, label, actionOpts),
    getImage: ops.getImage,
    getImageMeta: ops.getImageMeta,
    getImageThumbnail: ops.getImageThumbnail,
    touchImages: (ids) => ops.touchImages(ids),
    searchImages: (query) => ops.searchImages(projectId, query),
    getAgentMemory: (slug) => ops.getAgentMemory(projectId, slug),
    listAgentMemories: () => ops.listAgentMemories(projectId),
    upsertAgentMemory: (slug, title, summary, content) =>
      ops.upsertAgentMemory(projectId, slug, title, summary, content),
    touchMemory: (slug) => ops.touchMemory(projectId, slug),
    searchMemories: (query) => ops.searchMemories(projectId, query)
  };

  /** Append to the activity log, avoiding duplicate consecutive entries. */
  const logActivity = (text: string, nested = false) => {
    const last = activityLog[activityLog.length - 1];
    if (last && last.text === text && last.nested === nested) return;
    activityLog = [...activityLog, { text, nested }];
  };

  const onEvent = (event: EngineEvent) => {
    if (event.type.startsWith('debug_')) {
      debugEvents = [...debugEvents, event];
    }

    if (event.type === 'text_delta') {
      streamingText += event.text;
      statusText = '';
    } else if (event.type === 'thought_delta') {
      streamingThought += event.text;
    } else if (event.type === 'status') {
      statusText = event.text;
      if (event.text) logActivity(event.text);
    }
    else if (event.type === 'image_generating') {
      if (subagentProgress) {
        subagentProgress = {
          ...subagentProgress,
          steps: [...subagentProgress.steps, { text: `Generating: ${event.label}`, done: false }]
        };
      }
      statusText = `Generating: ${event.label}...`;
      logActivity(`Generating: ${event.label}`, !!subagentProgress);
    }
    else if (event.type === 'image_complete') {
      opts.onImageGenerated?.(event.imageId);
      if (subagentProgress) {
        const steps = subagentProgress.steps.map((s) =>
          !s.done && s.text.startsWith('Generating:') ? { text: `Generated: ${event.label}`, done: true } : s
        );
        subagentProgress = { ...subagentProgress, steps };
      }
      statusText = `Generated: ${event.label}`;
    }
    else if (event.type === 'image_viewing') {
      if (subagentProgress) {
        subagentProgress = {
          ...subagentProgress,
          steps: [...subagentProgress.steps, { text: 'Viewing reference images', done: true }]
        };
      }
      statusText = `Viewing ${event.imageIds.length} image(s)...`;
      logActivity('Viewing images', !!subagentProgress);
    }
    else if (event.type === 'subagent_start') {
      subagentProgress = {
        agentType: event.agentType,
        steps: []
      };
      statusText = '';
      logActivity(`Dispatching ${event.agentType} agent`);
    }
    else if (event.type === 'subagent_end') {
      for (const imageId of event.imageIds) {
        opts.onImageGenerated?.(imageId);
      }
      subagentProgress = null;
      statusText = '';
    }
    else if (event.type === 'memory_updated') {
      refreshAgentMemories();
      statusText = `Memory updated: ${event.slug}`;
      logActivity(`Memory updated: ${event.slug}`);
    }
    else if (event.type === 'error') errorText = event.message;
    else if (event.type === 'done') {
      statusText = '';
    }
  };

  const attachments: UserAttachment[] = (opts.files ?? []).map((f) => ({
    blob: f,
    label: f.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')
  }));

  try {
    const preTurnHistoryLength = ctx.apiHistory.length;
    const result = await runAgentTurn(ctx, actions, opts.text, onEvent, attachments, opts.reattachImageIds ?? []);

    await ops.saveTurnResult(projectId, conversationId, session.id, {
      ...result,
      activityLog: activityLog.length > 0 ? $state.snapshot(activityLog) : undefined
    }, preTurnHistoryLength);

    // Only refresh UI state if the user hasn't navigated away during the turn.
    if (getAppState().currentConversation?.id === conversationId) {
      await refreshConversation();
      await refreshOrchestratorSession();
      await refreshMessages();
      await refreshProjectImages();
    }
    streamingText = '';
    streamingThought = '';

    if (result.error) {
      const cancelled = result.error === 'Turn cancelled';
      errorText = cancelled ? 'Turn cancelled.' : `API error: ${result.error}`;
      if (!cancelled) {
        retryInput = opts.text;
        retryImageIds = result.userImageIds;
      }
    } else {
      retryInput = '';
      retryImageIds = [];
    }
  } catch (err) {
    errorText = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    abortController = null;
    isRunning = false;
  }

  return true;
}

/** Retry the last failed turn, re-attaching any images from that turn. */
export async function retryMessage(onImageGenerated?: (imageId: string) => void): Promise<boolean> {
  if (!retryInput || isRunning) return false;

  const text = retryInput;
  const imageIds = retryImageIds;
  retryInput = '';
  retryImageIds = [];
  errorText = '';

  return sendMessage({ text, reattachImageIds: imageIds, onImageGenerated });
}

/**
 * Roll back the most recent successful turn. Deletes the last user+assistant
 * messages, truncates the orchestrator session's history, and returns the
 * user's text so the UI can prefill the input field. Returns null if
 * rollback isn't possible (no session or no preTurnHistoryLength).
 */
export async function rollbackTurn(): Promise<{ userText: string; userImageIds: string[] } | null> {
  const app = getAppState();
  if (isRunning || !app.currentConversation || !app.orchestratorSession) return null;

  const result = await ops.rollbackLastTurn(app.currentConversation.id, app.orchestratorSession.id);
  if (!result) return null;

  await refreshConversation();
  await refreshOrchestratorSession();
  await refreshMessages();

  return result;
}
