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
  initializeProject,
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
import { maybeNameProject } from '$lib/services/projectNaming';

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
/** Brief hold after turn completes: streaming block stays visible while persisted message takes over. */
let isSettling = $state(false);
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
    get isSettling() { return isSettling; },
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

/**
 * Settle the streaming block: mark isRunning false but keep the streaming
 * content visible (via isSettling) for one frame so the persisted message
 * can render underneath. Then clear streaming state.
 */
async function settleTurn(): Promise<void> {
  isRunning = false;
  isSettling = true;

  // Two rAFs: first lets Svelte render the persisted message into the DOM,
  // second lets layout complete so the transition is invisible.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  streamingText = '';
  streamingThought = '';
  activityLog = [];
  subagentProgress = null;
  isSettling = false;
}

// ── Fake turn simulation (debug only) ──

export type SimulationStep =
  | { type: 'activity'; text: string; nested?: boolean; delay: number }
  | { type: 'stream'; text: string; delay: number }
  | { type: 'status'; text: string; delay: number }
  | { type: 'subagent_start'; agentType: string; delay: number }
  | { type: 'subagent_end'; delay: number };

/**
 * Simulate a turn by replaying scripted state transitions through the
 * same reactive pathways as a real turn. No API calls, no DB writes.
 * Returns a promise that resolves when the simulation completes.
 */
export async function simulateTurn(steps: SimulationStep[]): Promise<void> {
  if (isRunning) return;

  isRunning = true;
  streamingText = '';
  streamingThought = '';
  statusText = 'Thinking...';
  errorText = '';
  subagentProgress = null;
  activityLog = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const step of steps) {
    await sleep(step.delay);
    if (!isRunning) break; // cancelled

    if (step.type === 'activity') {
      activityLog = [...activityLog, { text: step.text, nested: step.nested ?? false }];
    } else if (step.type === 'stream') {
      streamingText += step.text;
      statusText = '';
    } else if (step.type === 'status') {
      statusText = step.text;
    } else if (step.type === 'subagent_start') {
      subagentProgress = { agentType: step.agentType, steps: [] };
      activityLog = [...activityLog, { text: `Dispatching ${step.agentType} agent`, nested: false }];
    } else if (step.type === 'subagent_end') {
      subagentProgress = null;
    }
  }

  streamingText = '';
  statusText = '';
  isRunning = false;
  subagentProgress = null;
}

// ── Full turn simulation (debug only) ──
// Exercises the complete user → streaming → persist → refresh lifecycle.

/** Canned multi-paragraph responses for simulated turns. */
const SAMPLE_RESPONSES = [
  `I've been thinking about the composition you described. The contrast between the warm foreground tones and that cooler background could work really well.\n\nOne approach: start with a loose wash for the sky, letting the pigment granulate naturally. Then build up the foreground elements with more deliberate strokes. The key is leaving enough breathing room between the two zones.\n\nWant me to generate a quick color study to explore this?`,

  `That's an interesting direction. The reference images you shared have a strong sense of depth, mostly through atmospheric perspective rather than linear perspective.\n\nI'd suggest leaning into that. Keep the foreground elements saturated and high-contrast, then progressively desaturate and lighten as things recede. Even a subtle shift makes a big difference.\n\nI can pull together a few variations if you want to compare approaches side by side.`,

  `Looking at the previous iterations, I think the main thing holding the piece back is the value structure. The darks aren't dark enough in the midground, which flattens the whole image.\n\nHere's what I'd try:\n\n- Push the shadow values in the central area down by about 20%\n- Add a rim light on the main subject to separate it from the background\n- Warm up the highlights slightly to unify the light source\n\nThese are relatively small moves but they should add a lot of dimension.`,

  `The texture work in your last piece was really strong. Those dry brush passages in the lower third create a nice visual rhythm.\n\nFor this next one, I think we should carry that energy into the upper portion too. Right now there's a disconnect between the loose, expressive bottom half and the smoother rendering up top. Bridging that gap would make the whole thing feel more cohesive.\n\nLet me sketch out a rough plan for the mark-making strategy across the full canvas.`,
];

let sampleResponseIndex = 0;

/**
 * Simulate a complete user+assistant turn. Persists the user message,
 * streams a canned assistant response with realistic timing, then
 * persists the assistant message and refreshes the UI. Exercises the
 * same DB + reactive pathways as a real turn.
 */
export async function simulateFullTurn(userText: string): Promise<boolean> {
  const app = getAppState();
  if (isRunning) return false;
  if (!app.currentProject || !app.currentConversation) return false;

  const projectId = app.currentProject.id;
  const conversationId = app.currentConversation.id;

  abortController = new AbortController();
  isRunning = true;
  streamingText = '';
  streamingThought = '';
  statusText = 'Thinking...';
  errorText = '';
  subagentProgress = null;
  activityLog = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Pick the next canned response and advance the index.
  const fullResponse = SAMPLE_RESPONSES[sampleResponseIndex % SAMPLE_RESPONSES.length];
  sampleResponseIndex++;

  // Simulate realistic streaming: split into small chunks.
  const words = fullResponse.split(/(?<=\s)/); // split keeping whitespace attached
  const chunks: string[] = [];
  let buf = '';
  for (const w of words) {
    buf += w;
    // Flush every ~3-6 words for a natural cadence.
    if (buf.split(/\s+/).filter(Boolean).length >= 3 + Math.floor(Math.random() * 4)) {
      chunks.push(buf);
      buf = '';
    }
  }
  if (buf) chunks.push(buf);

  try {
    // 1. Persist user message immediately.
    const { db } = await import('$lib/db/database');
    const timestamp = Date.now();
    await db.messages.add({
      id: crypto.randomUUID(),
      conversationId,
      role: 'user' as const,
      text: userText,
      imageIds: [],
      createdAt: timestamp
    });
    await refreshMessages();

    // 2. Thinking pause.
    await sleep(600 + Math.random() * 400);
    if (!isRunning) return false;

    // 3. Simulate activity log (tool use, subagent dispatch, etc.)
    activityLog = [...activityLog, { text: 'Viewing images', nested: false }];
    statusText = 'Viewing 3 image(s)...';
    await sleep(400 + Math.random() * 300);
    if (!isRunning) return false;

    activityLog = [...activityLog, { text: 'Dispatching text-to-image agent', nested: false }];
    subagentProgress = { agentType: 'text-to-image', steps: [] };
    statusText = '';
    await sleep(300 + Math.random() * 200);
    if (!isRunning) return false;

    subagentProgress = {
      ...subagentProgress!,
      steps: [{ text: 'Generating: color_study_v2', done: false }]
    };
    activityLog = [...activityLog, { text: 'Generating: color_study_v2', nested: true }];
    statusText = 'Generating: color_study_v2...';
    await sleep(800 + Math.random() * 400);
    if (!isRunning) return false;

    subagentProgress = {
      ...subagentProgress!,
      steps: [{ text: 'Generated: color_study_v2', done: true }]
    };
    statusText = 'Generated: color_study_v2';
    await sleep(300);
    if (!isRunning) return false;

    subagentProgress = null;
    activityLog = [...activityLog, { text: 'Memory updated: palette-notes', nested: false }];
    statusText = '';
    await sleep(200);
    if (!isRunning) return false;

    // 4. Stream the response.
    for (const chunk of chunks) {
      if (!isRunning) break;
      streamingText += chunk;
      statusText = '';
      await sleep(30 + Math.random() * 60);
    }

    if (!isRunning) return false;

    // 4. Persist assistant message.
    const assistantTimestamp = Date.now();
    const finalActivityLog = activityLog.length > 0
      ? activityLog.map(e => ({ text: e.text, nested: e.nested }))
      : undefined;

    await db.messages.add({
      id: crypto.randomUUID(),
      conversationId,
      role: 'assistant' as const,
      text: streamingText,
      imageIds: [],
      ...(finalActivityLog ? { activityLog: finalActivityLog } : {}),
      createdAt: assistantTimestamp
    });
    await db.conversations.update(conversationId, { updatedAt: assistantTimestamp });
    await db.projects.update(projectId, { updatedAt: assistantTimestamp });

    // 5. Refresh UI state, then settle the streaming block.
    if (getAppState().currentConversation?.id === conversationId) {
      await refreshMessages();
    }

    abortController = null;
    await settleTurn();
  } catch (err) {
    errorText = `Simulation error: ${err instanceof Error ? err.message : String(err)}`;
    abortController = null;
    isRunning = false;
  }

  return true;
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

    if (result.error) {
      streamingText = '';
      streamingThought = '';
      const cancelled = result.error === 'Turn cancelled';
      errorText = cancelled ? 'Turn cancelled.' : `API error: ${result.error}`;
      if (!cancelled) {
        retryInput = opts.text;
        retryImageIds = result.userImageIds;
      }
      abortController = null;
      isRunning = false;
    } else {
      retryInput = '';
      retryImageIds = [];

      // Fire-and-forget: auto-name uninitialized projects.
      const currentApp = getAppState();
      if (currentApp.currentProject?.initialized === false) {
        maybeNameProject({
          apiKey: ctx.apiKey,
          project: currentApp.currentProject,
          messages: currentApp.messages,
          hasNewImages: result.assistantImageIds.length > 0,
          onNamed: (name, description) => initializeProject(projectId, name, description)
        });
      }

      // Settle: keep streaming block visible while persisted message renders.
      abortController = null;
      await settleTurn();
    }
  } catch (err) {
    errorText = `Error: ${err instanceof Error ? err.message : String(err)}`;
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
