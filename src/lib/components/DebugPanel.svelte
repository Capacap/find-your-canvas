<script lang="ts">
  import { getAppState, refreshMessages } from '$lib/stores/appState.svelte';
  import {
    getTurnState,
    simulateTurn,
    simulateFullTurn,
    cancelTurn,
    type SimulationStep,
  } from '$lib/stores/turnState.svelte';

  interface Props {
    scrollMetrics: { scrollTop: number; scrollHeight: number; clientHeight: number; spacerHeight: number };
    layoutShifts: Array<{ time: number; value: number; sources: string[] }>;
    roFireCount: number;
    onclearshifts: () => void;
    onanchor: () => void;
    onclose: () => void;
  }

  let { scrollMetrics, layoutShifts, roFireCount, onclearshifts, onanchor, onclose }: Props = $props();

  const app = getAppState();
  const turn = getTurnState();

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
    <strong>Scroll Debug</strong>
    <button onclick={onclose}>&times;</button>
  </div>

  <div class="debug-section">
    <div class="debug-label">Scroll Metrics</div>
    <div class="debug-metrics">
      <span>scrollTop: {scrollMetrics.scrollTop}</span>
      <span>scrollHeight: {scrollMetrics.scrollHeight}</span>
      <span>clientHeight: {scrollMetrics.clientHeight}</span>
      <span>spacer: {scrollMetrics.spacerHeight}</span>
      <span>RO fires: {roFireCount}</span>
    </div>
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
    <div class="debug-label">Simulate Turn</div>
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
  </div>

  <div class="debug-section">
    <div class="debug-label">Layout Shifts ({layoutShifts.length})</div>
    <div class="debug-buttons">
      <button onclick={onclearshifts}>Clear</button>
      <button onclick={() => {
        const text = layoutShifts.map(s => `${s.time}ms\t${s.value}\t${s.sources.join(', ')}`).join('\n');
        navigator.clipboard.writeText(text);
      }}>Copy log</button>
    </div>
    <div class="debug-shifts">
      {#each layoutShifts.slice(-10) as shift}
        <div class="debug-shift-entry">
          <span class="debug-shift-time">{shift.time}ms</span>
          <span class="debug-shift-value">{shift.value}</span>
          <span class="debug-shift-sources">{shift.sources.join(', ')}</span>
        </div>
      {/each}
      {#if layoutShifts.length === 0}
        <div class="debug-shift-empty">No shifts detected</div>
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

  .debug-metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }

  .debug-metrics span {
    white-space: nowrap;
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

  .debug-shifts {
    max-height: 120px;
    overflow-y: auto;
    margin-top: 4px;
  }

  .debug-shift-entry {
    display: flex;
    gap: 8px;
    padding: 1px 0;
    border-bottom: 1px solid #222;
  }

  .debug-shift-time {
    color: #888;
    min-width: 60px;
  }

  .debug-shift-value {
    color: #e88;
    min-width: 50px;
  }

  .debug-shift-sources {
    color: #8be;
  }

  .debug-shift-empty {
    color: #666;
    font-style: italic;
  }
</style>
