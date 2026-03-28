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

  <nav class="topbar">
    <span class="topbar-logo"><span class="topbar-prefix">find your</span> <span class="topbar-name">Canvas</span></span>
    <div class="topbar-links">
      <a href="https://github.com/capacap/find-your-canvas" target="_blank" rel="noopener" class="topbar-link">GitHub</a>
      {#if ready && hasKey}
        <button class="topbar-cta" onclick={handleContinue}>Open workspace</button>
      {/if}
    </div>
  </nav>

  <main class="hero">
      <h1 class="hero-title">The hardest part of creating is knowing where to start.</h1>
      <p class="hero-subtitle">
        An AI partner that develops creative direction with you.
        Explore ideas through conversation and visuals.
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
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" class="hint-link">Get an API key</a> · Your key stays in your browser, never sent to our servers.
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

  /* Topbar */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-8);
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
  }
  .topbar-logo {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3em;
  }
  .topbar-prefix {
    font-family: var(--font-serif);
    font-size: var(--text-sm);
    font-style: italic;
    color: var(--color-text-tertiary);
  }
  .topbar-name {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--color-accent);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .topbar-links {
    display: flex;
    align-items: center;
    gap: var(--space-5);
  }
  .topbar-link {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-decoration: none;
    transition: color var(--transition-fast);
  }
  .topbar-link:hover {
    color: var(--color-text);
  }
  .topbar-cta {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-accent);
    background: none;
    border: 1px solid var(--color-accent);
    border-radius: var(--radius-md);
    padding: var(--space-1) var(--space-4);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .topbar-cta:hover {
    background: var(--color-accent);
    color: var(--color-bg);
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
    max-width: 800px;
    margin: 0 auto;
  }

  /* Hero text */
  .hero-title {
    font-family: var(--font-serif);
    font-size: 4rem;
    font-weight: 400;
    line-height: 1.15;
    color: var(--color-text);
    margin: 0 0 var(--space-6);
  }
  .hero-subtitle {
    font-size: var(--text-lg);
    color: var(--color-text-secondary);
    line-height: 1.6;
    margin: 0 0 var(--space-10);
    max-width: 44ch;
  }

  /* Actions */
  .hero-actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    max-width: 380px;
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
  .hint-link {
    color: var(--color-accent);
    text-decoration: none;
    transition: color var(--transition-fast);
  }
  .hint-link:hover {
    color: var(--color-accent-hover);
  }

  /* Features */
  .features {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-8);
    padding: var(--space-12) var(--space-8);
    max-width: 960px;
    margin: 0 auto;
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
