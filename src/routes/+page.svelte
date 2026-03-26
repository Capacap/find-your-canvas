<script lang="ts">
  import '$lib/styles/tokens.css';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import {
    getAppState,
    loadSettings,
    loadProjects,
    saveSettings,
  } from '$lib/stores/appState.svelte';

  const app = getAppState();

  let apiKeyInput = $state('');
  let ready = $state(false);
  let saving = $state(false);

  const hasKey = $derived(!!app.settings?.geminiApiKey);
  const hasProjects = $derived(app.projects.length > 0);

  onMount(async () => {
    await loadSettings();
    await loadProjects();
    if (app.settings?.geminiApiKey) {
      apiKeyInput = app.settings.geminiApiKey;
    }
    ready = true;
  });

  async function handleGetStarted() {
    if (!apiKeyInput.trim()) return;
    saving = true;
    await saveSettings({ geminiApiKey: apiKeyInput.trim() });
    goto('/workspace');
  }

  function handleContinue() {
    goto('/workspace');
  }
</script>

<div class="landing" class:ready>

  <header class="landing-header">
    <span class="logo">Banana Orchestra</span>
  </header>

  <main class="hero">
    <h1 class="hero-title">Creative vision,<br>orchestrated by AI</h1>
    <p class="hero-subtitle">
      A collaborative workspace where you direct and an ensemble of AI agents
      compose, illustrate, and iterate alongside you.
    </p>

    {#if ready}
      <div class="hero-actions">
        {#if hasKey && hasProjects}
          <button class="btn-primary" onclick={handleContinue}>
            Continue to workspace
          </button>
          <p class="hint">
            {app.projects.length} project{app.projects.length === 1 ? '' : 's'} waiting
          </p>
        {:else if hasKey}
          <button class="btn-primary" onclick={handleContinue}>
            Open workspace
          </button>
        {:else}
          <form class="key-form" onsubmit={(e) => { e.preventDefault(); handleGetStarted(); }}>
            <input
              type="password"
              class="key-input"
              placeholder="Gemini API key"
              bind:value={apiKeyInput}
            />
            <button class="btn-primary" type="submit" disabled={!apiKeyInput.trim() || saving}>
              {saving ? 'Starting...' : 'Get started'}
            </button>
          </form>
          <p class="hint">
            Your key stays in your browser. Nothing is sent to our servers.
          </p>
        {/if}
      </div>
    {/if}
  </main>

  <section class="features">
    <div class="feature">
      <h3>Direct, don't type prompts</h3>
      <p>Describe your vision in conversation. The orchestrator breaks it into tasks and delegates to specialist agents.</p>
    </div>
    <div class="feature">
      <h3>Persistent memory</h3>
      <p>Agents remember your style preferences, character details, and project context across sessions.</p>
    </div>
    <div class="feature">
      <h3>Your images, your project</h3>
      <p>Everything lives in your browser. Export anytime. No accounts, no cloud lock-in.</p>
    </div>
  </section>

</div>

<style>
  .landing {
    min-height: 100vh;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--font-sans);
    display: flex;
    flex-direction: column;
    opacity: 0;
    transition: opacity 400ms ease;
  }
  .landing.ready {
    opacity: 1;
  }

  /* Header */
  .landing-header {
    padding: var(--space-6) var(--space-8);
  }
  .logo {
    font-family: var(--font-serif);
    font-size: var(--text-lg);
    color: var(--color-accent);
    letter-spacing: 0.01em;
  }

  /* Hero */
  .hero {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: var(--space-12) var(--space-8);
    max-width: 640px;
    margin: 0 auto;
  }
  .hero-title {
    font-family: var(--font-serif);
    font-size: 3rem;
    font-weight: 400;
    line-height: 1.2;
    color: var(--color-text);
    margin: 0 0 var(--space-6);
  }
  .hero-subtitle {
    font-size: var(--text-lg);
    color: var(--color-text-secondary);
    line-height: 1.6;
    margin: 0 0 var(--space-10);
    max-width: 48ch;
  }

  /* Actions */
  .hero-actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    max-width: 400px;
  }

  .key-form {
    display: flex;
    gap: var(--space-3);
    width: 100%;
  }
  .key-input {
    flex: 1;
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-base);
    font-family: var(--font-mono);
    outline: none;
    transition: border-color var(--transition-fast);
  }
  .key-input:focus {
    border-color: var(--color-accent);
  }
  .key-input::placeholder {
    color: var(--color-text-tertiary);
    font-family: var(--font-sans);
  }

  .btn-primary {
    padding: var(--space-3) var(--space-6);
    background: var(--color-accent);
    color: var(--color-bg);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--transition-fast);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .hint {
    font-size: var(--text-sm);
    color: var(--color-text-tertiary);
    margin: 0;
  }

  /* Features */
  .features {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-8);
    padding: var(--space-12) var(--space-8);
    max-width: 960px;
    margin: 0 auto;
    border-top: none;
  }
  .feature h3 {
    font-family: var(--font-serif);
    font-size: var(--text-base);
    font-weight: 400;
    color: var(--color-text);
    margin: 0 0 var(--space-2);
  }
  .feature p {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: 1.5;
    margin: 0;
  }
</style>
