<script lang="ts">
  import { getAppState, refreshMessages } from '$lib/stores/appState.svelte';
  import {
    getTurnState,
    simulateTurn,
    simulateFullTurn,
    cancelTurn,
    type SimulationStep,
  } from '$lib/stores/turnState.svelte';
  import { debugInjectFault } from '$lib/engine/turn';
  import { buildContextDump } from '$lib/engine/context-dump';
  import { buildOrchestratorPrompt } from '$lib/engine/agents/orchestrator';
  import { countTokens } from '$lib/engine/gemini';
  import { listAgentSessions } from '$lib/db/operations';
  import { TEXT_MODEL } from '$lib/types/schema';
  import type { Content } from '@google/genai';

  interface Props {
    onanchor: () => void;
    onclose: () => void;
  }

  let { onanchor, onclose }: Props = $props();

  const app = getAppState();
  const turn = getTurnState();

  // ── Context snapshot ──
  let snapshotStatus = $state<string | null>(null);

  async function copyContext() {
    if (!app.currentProject || !app.currentConversation) {
      snapshotStatus = 'No conversation';
      return;
    }
    snapshotStatus = 'Building...';

    try {
      const session = app.orchestratorSession;
      const history: Content[] = session?.history ?? [];

      const systemPrompt = session?.systemPrompt
        || buildOrchestratorPrompt(
          app.currentProject.name,
          app.agentMemories,
          app.projectImages,
          app.projectImages.filter(img => img.favorite)
        );

      const allSessions = await listAgentSessions(app.currentConversation.id);
      const subagentSessions = allSessions.filter(s => s.agentType !== 'orchestrator');

      const { text: contextDump, imageCount, imageTotalKB } = buildContextDump(systemPrompt, history, subagentSessions);

      let tokenCount: number | null = null;
      const apiKey = app.settings?.geminiApiKey;
      if (apiKey) {
        tokenCount = await countTokens(apiKey, TEXT_MODEL, history, systemPrompt);
      }

      const turns = Math.floor(history.length / 2);
      const header = [
        `Snapshot: ${new Date().toISOString()}`,
        `Turns: ${turns}  Entries: ${history.length}  Images: ${imageCount} (${imageTotalKB} KB)`,
        tokenCount != null ? `Tokens: ${tokenCount}` : null,
        '---',
      ].filter(Boolean).join('\n');

      await navigator.clipboard.writeText(`${header}\n${contextDump}`);
      snapshotStatus = `Copied (${turns}t, ${tokenCount ?? '?'}tok)`;
    } catch {
      snapshotStatus = 'Error';
    }
  }

  let fakeMessageCounter = $state(0);

  async function debugAddMessage(role: 'user' | 'assistant', activityEntries = 0) {
    if (!app.currentConversation) return;
    const { db } = await import('$lib/db/database');
    const log: Array<{ text: string; nested: boolean }> = [];
    if (role === 'assistant') {
      if (activityEntries >= 1) log.push({ text: 'Dispatching text-to-image agent', nested: false });
      if (activityEntries >= 2) log.push({ text: 'Viewing images', nested: true });
      if (activityEntries >= 3) log.push({ text: 'Generating: test_image', nested: true });
      if (activityEntries >= 4) log.push({ text: 'Memory updated: art-style', nested: false });
    }
    const n = ++fakeMessageCounter;
    await db.messages.add({
      id: crypto.randomUUID(),
      conversationId: app.currentConversation.id,
      role,
      text: role === 'user'
        ? `Debug user message #${n}. This is filler text to simulate a real user message with enough length for layout testing.`
        : `Debug assistant response #${n}. Here is a longer response with enough text to take up vertical space in the chat column so we can test scroll behavior properly.`,
      imageIds: [],
      ...(log.length > 0 ? { activityLog: log } : {}),
      createdAt: Date.now()
    });
    await refreshMessages();
  }

  const debugSimScript: SimulationStep[] = [
    { type: 'status', text: 'Thinking...', delay: 300 },
    { type: 'activity', text: 'Dispatching text-to-image agent', delay: 800 },
    { type: 'subagent_start', agentType: 'text-to-image', delay: 200 },
    { type: 'activity', text: 'Viewing images', nested: true, delay: 600 },
    { type: 'activity', text: 'Generating: debug_test_image', nested: true, delay: 800 },
    { type: 'subagent_end', delay: 500 },
    { type: 'stream', text: 'Here is the assistant response streaming in. ', delay: 300 },
    { type: 'stream', text: 'This text arrives incrementally to simulate real streaming behavior. ', delay: 200 },
    { type: 'stream', text: 'Each chunk triggers the $effect that recalculates the spacer.', delay: 200 },
  ];
</script>

<div class="debug-panel">
  <div class="debug-header">
    <strong>Debug</strong>
    <button onclick={onclose}>&times;</button>
  </div>

  <div class="debug-section">
    <div class="debug-label">Add Messages</div>
    <div class="debug-buttons">
      <button onclick={() => debugAddMessage('user')}>+ User msg</button>
      <button onclick={() => debugAddMessage('assistant', 0)}>+ Asst (no log)</button>
      <button onclick={() => debugAddMessage('assistant', 3)}>+ Asst (3 log)</button>
      <button onclick={() => debugAddMessage('assistant', 4)}>+ Asst (4 log)</button>
    </div>
  </div>

  <div class="debug-section">
    <div class="debug-label">Simulate Turn / Fault Injection</div>
    <div class="debug-buttons">
      <button onclick={() => simulateTurn(debugSimScript)} disabled={turn.isRunning}>
        Stream only
      </button>
      <button onclick={() => simulateFullTurn(
        'Can you try a warmer palette for the background? The cool tones feel disconnected from the foreground.',
        onanchor
      )} disabled={turn.isRunning}>
        Full turn
      </button>
      <button onclick={() => cancelTurn()} disabled={!turn.isRunning}>Cancel</button>
    </div>
    <div class="debug-buttons" style="margin-top: 4px;">
      <button onclick={() => debugInjectFault(0)} title="Next turn fails before first API call">
        Fault R0
      </button>
      <button onclick={() => debugInjectFault(1)} title="Next turn fails after first round">
        Fault R1
      </button>
    </div>
  </div>

  <div class="debug-section">
    <div class="debug-label">Context Snapshot</div>
    <div class="debug-buttons">
      <button onclick={copyContext}>Copy context</button>
      {#if snapshotStatus}
        <span class="debug-snapshot-status">{snapshotStatus}</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .debug-panel {
    position: fixed;
    bottom: 12px;
    right: 12px;
    width: 340px;
    max-height: 70vh;
    overflow-y: auto;
    background: #1a1816;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 12px;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: #ccc;
    z-index: 9999;
  }

  .debug-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    color: var(--color-accent);
  }

  .debug-header button {
    background: none;
    border: none;
    color: #999;
    font-size: 16px;
    cursor: pointer;
  }

  .debug-section {
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid #2a2a2a;
  }

  .debug-label {
    color: #999;
    margin-bottom: 4px;
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.5px;
  }

  .debug-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .debug-buttons button {
    background: #2a2826;
    border: 1px solid #444;
    color: #ccc;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
  }

  .debug-buttons button:hover {
    background: #3a3836;
  }

  .debug-buttons button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .debug-snapshot-status {
    color: #8be;
    align-self: center;
  }
</style>
