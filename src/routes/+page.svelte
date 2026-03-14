<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getAppState,
    loadSettings,
    saveSettings,
    loadProjects,
    selectProject,
    deselectProject,
    createProject,
    selectConversation,
    createConversation,
    deleteProject,
    deleteConversation,
    renameConversation,
    getImageUrl,
    revokeImageUrls,
    exportProject,
    importProject,
    deleteImage
  } from '$lib/stores/appState.svelte';
  import { getTurnState, sendMessage, retryMessage, clearTurnError, clearDebugLog, cancelTurn } from '$lib/stores/turnState.svelte';
  import { debugInjectFault, buildSystemPrompt } from '$lib/engine/orchestrator';
  import { countTokens } from '$lib/engine/gemini';
  import { TEXT_MODEL } from '$lib/types/schema';
  import type { Content } from '@google/genai';
  import { marked } from 'marked';

  marked.setOptions({ breaks: true, gfm: true });

  // ── State ──

  const app = getAppState();
  const turn = getTurnState();

  // Form inputs
  let userInput = $state('');
  let apiKeyInput = $state('');
  let newProjectName = $state('');

  // Panel toggles
  let showSettings = $state(false);
  let showMemoryPanel = $state(false);
  let showImageGallery = $state(false);
  let showDebug = $state(false);
  let debugTab = $state<'context' | 'log'>('log');
  let lightboxImageId = $state<string | null>(null);
  let lightboxImage = $derived(app.projectImages.find((img) => img.id === lightboxImageId));

  // File attachments
  const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
  let pendingFiles = $state<File[]>([]);
  let pendingFileUrls = $state<Map<File, string>>(new Map());
  let isDragging = $state(false);
  let attachInput = $state<HTMLInputElement>(null!);
  let importFileInput = $state<HTMLInputElement>(null!);

  // Image URL resolution: reactive projection of the store's LRU cache.
  let resolvedImageUrls = $state<Record<string, string>>({});

  // Page-level status for import/export (turn status lives in turnState).
  let pageStatus = $state('');

  // ── Lifecycle ──

  onMount(async () => {
    await loadSettings();
    await loadProjects();
    apiKeyInput = app.settings?.geminiApiKey ?? '';
  });

  // Resolve image URLs whenever messages or project images change.
  $effect(() => {
    const imageRefPattern = /\[image:([^\]]+)\]/g;
    for (const msg of app.messages) {
      for (const imgId of msg.imageIds) resolveImageId(imgId);
      let match;
      while ((match = imageRefPattern.exec(msg.text)) !== null) resolveImageId(match[1]);
    }
  });

  $effect(() => {
    for (const img of app.projectImages) resolveImageId(img.id);
  });

  // ── Image URL resolution ──

  async function resolveImageId(imageId: string) {
    if (resolvedImageUrls[imageId]) return;
    const url = await getImageUrl(imageId);
    if (url) {
      resolvedImageUrls = { ...resolvedImageUrls, [imageId]: url };
    }
  }

  // ── Settings ──

  async function handleSaveSettings() {
    await saveSettings({ geminiApiKey: apiKeyInput });
    showSettings = false;
  }

  // ── Project actions ──

  async function handleCreateProject() {
    if (!newProjectName.trim()) return;
    await createProject(newProjectName.trim());
    newProjectName = '';
  }

  async function handleSelectProject(id: string) {
    revokeImageUrls();
    resolvedImageUrls = {};
    await selectProject(id);
  }

  async function handleDeleteProject() {
    if (!app.currentProject) return;
    if (!confirm(`Delete project "${app.currentProject.name}" and all its data?`)) return;
    await deleteProject();
  }

  async function handleExportProject() {
    if (!app.currentProject) return;
    pageStatus = 'Exporting project...';
    try {
      await exportProject();
      pageStatus = '';
    } catch (err) {
      pageStatus = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function handleImportProject(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    pageStatus = 'Importing project...';
    try {
      await importProject(file);
      pageStatus = '';
    } catch (err) {
      pageStatus = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    input.value = '';
  }

  // ── Conversation actions ──

  async function handleCreateConversation(title = 'New conversation') {
    await createConversation(title);
  }

  async function handleSelectConversation(id: string) {
    resolvedImageUrls = {};
    clearTurnError();
    clearDebugLog();
    contextSnapshot = null;
    await selectConversation(id);
  }

  async function handleDeleteConversation(id: string, title: string) {
    if (!confirm(`Delete conversation "${title}"?`)) return;
    await deleteConversation(id);
  }

  // ── Turn execution ──

  async function handleSend() {
    if ((!userInput.trim() && pendingFiles.length === 0) || turn.isRunning) return;
    if (!app.currentProject) return;

    const text = userInput.trim();
    const filesToSend = [...pendingFiles];
    clearPendingFiles();

    // Auto-create a conversation if none selected, titled from the first message.
    if (!app.currentConversation) {
      const title = text.length > 50 ? text.slice(0, 50) + '...' : text;
      await handleCreateConversation(title);
    } else if (app.messages.length === 0 && app.currentConversation.title === 'New conversation') {
      const title = text.length > 50 ? text.slice(0, 50) + '...' : text;
      await renameConversation(app.currentConversation.id, title);
    }

    userInput = '';
    await sendMessage({ text, files: filesToSend, onImageGenerated: resolveImageId });
  }

  async function handleRetry() {
    await retryMessage(resolveImageId);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── Rendering ──

  function renderMessageText(text: string): string {
    const withImages = text.replace(
      /\[image:([^\]]+)\]/g,
      (_, id) => {
        const url = resolvedImageUrls[id];
        if (url) return `<img src="${url}" alt="${id}" class="inline-image" data-image-id="${id}" />`;
        return `<span class="image-missing">Image not found</span>`;
      }
    );
    return marked.parse(withImages, { async: false }) as string;
  }

  // ── Lightbox ──

  function openLightbox(imageId: string) {
    lightboxImageId = imageId;
  }

  function closeLightbox() {
    lightboxImageId = null;
  }

  function handleMessageClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG' && target.dataset.imageId) {
      openLightbox(target.dataset.imageId);
    }
  }

  function handleLightboxKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeLightbox();
  }

  // ── File attachments ──

  function addFiles(files: FileList | File[]) {
    const images = Array.from(files).filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type));
    if (images.length > 0) pendingFiles = [...pendingFiles, ...images];
  }

  function clearPendingFiles() {
    pendingFiles = [];
    for (const url of pendingFileUrls.values()) URL.revokeObjectURL(url);
    pendingFileUrls = new Map();
  }

  function getPendingFileUrl(file: File): string {
    let url = pendingFileUrls.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      pendingFileUrls = new Map(pendingFileUrls).set(file, url);
    }
    return url;
  }

  function removePendingFile(index: number) {
    const file = pendingFiles[index];
    const url = pendingFileUrls.get(file);
    if (url) {
      URL.revokeObjectURL(url);
      const next = new Map(pendingFileUrls);
      next.delete(file);
      pendingFileUrls = next;
    }
    pendingFiles = pendingFiles.filter((_, i) => i !== index);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    isDragging = true;
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragging = false;
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  }

  // ── Image management ──

  async function handleDeleteImage(imageId: string, label: string) {
    if (!confirm(`Delete "${label}"? References in messages will show as missing.`)) return;
    await deleteImage(imageId);
  }

  // ── Context snapshot ──

  interface ContextSnapshot {
    meta: {
      takenAt: number;
      contentEntries: number;
      turns: number;
      imageCount: number;
      imageTotalKB: number;
      tokenCount: number | null;
    };
    contextDump: string;
    systemPrompt: string;
  }

  let contextSnapshot = $state<ContextSnapshot | null>(null);
  let snapshotLoading = $state(false);

  /** Render a single Part to readable text. Returns null for parts that should be skipped. */
  function renderPart(part: any): string | null {
    // Structured parts first — these take priority over text.
    if (part.functionCall) {
      const name = part.functionCall.name ?? 'unknown';
      const args = part.functionCall.args ?? {};
      return `[Tool Call: ${name}]\n${JSON.stringify(args, null, 2)}`;
    }
    if (part.functionResponse) {
      const name = part.functionResponse.name ?? 'unknown';
      const resp = part.functionResponse.response ?? {};
      const redacted = { ...resp };
      for (const key of ['thumbnail', 'image'] as const) {
        const val = redacted[key] as { base64?: string; mimeType?: string } | undefined;
        if (val?.base64) {
          const kb = Math.ceil((val.base64.length * 3) / 4 / 1024);
          redacted[key] = { mimeType: val.mimeType, data: `[${kb} KB]` };
        }
      }
      return `[Tool Result: ${name}]\n${JSON.stringify(redacted, null, 2)}`;
    }
    if (part.inlineData?.data) {
      const kb = Math.ceil((part.inlineData.data.length * 3) / 4 / 1024);
      return `[Image: ${part.inlineData.mimeType ?? 'unknown'}, ${kb} KB]`;
    }
    // Thinking content (has thought flag + text).
    if (part.thought && part.text) return `[Thinking]\n${part.text}`;
    // Thought signatures are internal bookkeeping, skip.
    if (part.thoughtSignature) return null;
    // Plain text — return it, or null if empty.
    if (part.text) return part.text;
    // Empty text parts, unknown parts — skip.
    return null;
  }

  /** Count image data in a Part for the meta summary. */
  function countPartImages(part: any): { count: number; kb: number } {
    let count = 0, kb = 0;
    if (part.inlineData?.data) {
      count++;
      kb += Math.ceil((part.inlineData.data.length * 3) / 4 / 1024);
    }
    if (part.functionResponse?.response) {
      const resp = part.functionResponse.response;
      for (const key of ['thumbnail', 'image']) {
        if (resp[key]?.base64) {
          count++;
          kb += Math.ceil((resp[key].base64.length * 3) / 4 / 1024);
        }
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

  /**
   * Classify what a Part contains so we know how to join consecutive parts.
   * Plain text fragments from streaming should be concatenated without newlines;
   * structured parts (tool calls, images, etc.) need separation.
   */
  function isPlainTextPart(part: any): boolean {
    return !part.functionCall && !part.functionResponse && !part.inlineData
      && !part.thought && !part.thoughtSignature && !!part.text;
  }

  function buildContextDump(systemPrompt: string, history: Content[]): { text: string; imageCount: number; imageTotalKB: number } {
    const lines: string[] = [];
    let imageCount = 0;
    let imageTotalKB = 0;

    lines.push('=== SYSTEM INSTRUCTION ===', '', systemPrompt, '');

    // Merge consecutive entries with the same label. The Gemini SDK splits
    // streaming responses into many Content objects, which produces an
    // unreadable dump if rendered individually.
    let currentLabel = '';
    // Accumulate plain text fragments to concatenate without newlines.
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

      // Count images for meta.
      for (const part of parts) {
        const imgs = countPartImages(part);
        imageCount += imgs.count;
        imageTotalKB += imgs.kb;
      }

      // When a model Content has both text and functionCall parts, the
      // text is the model's reasoning/response and the function calls are
      // its tool invocations. Split them into separate labeled sections
      // so the text doesn't vanish under the "TOOL CALLS" header.
      const role = content.role ?? 'unknown';
      const hasNonCallContent = parts.some((p: any) => !p.functionCall && renderPart(p) !== null);
      const hasCalls = parts.some((p: any) => p.functionCall);

      const sections: { label: string; parts: any[] }[] = [];

      if (role === 'model' && hasNonCallContent && hasCalls) {
        // Split: text parts under MODEL, functionCall parts under TOOL CALLS.
        sections.push(
          { label: 'MODEL', parts: parts.filter((p: any) => !p.functionCall) },
          { label: 'TOOL CALLS', parts: parts.filter((p: any) => p.functionCall) }
        );
      } else {
        sections.push({ label: contentLabel(content), parts });
      }

      for (const section of sections) {
        // Pre-render parts; skip sections that produce no visible output
        // (e.g. Content with only thoughtSignature parts).
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
        }
      }
    }

    flushText();
    lines.push('');
    return { text: lines.join('\n'), imageCount, imageTotalKB };
  }

  async function takeSnapshot() {
    if (!app.currentProject) return;
    snapshotLoading = true;

    try {
      const history: Content[] = app.currentConversation?.apiHistory ?? [];
      const systemPrompt = buildSystemPrompt(
        app.currentProject.name,
        app.agentMemories,
        app.projectImages
      );

      const { text: contextDump, imageCount, imageTotalKB } = buildContextDump(systemPrompt, history);

      let tokenCount: number | null = null;
      const apiKey = app.settings?.geminiApiKey;
      if (apiKey) {
        tokenCount = await countTokens(apiKey, TEXT_MODEL, history, systemPrompt);
      }

      contextSnapshot = {
        meta: {
          takenAt: Date.now(),
          contentEntries: history.length,
          turns: Math.floor(history.length / 2),
          imageCount,
          imageTotalKB,
          tokenCount
        },
        contextDump,
        systemPrompt
      };
    } finally {
      snapshotLoading = false;
    }
  }
</script>

<div class="app">
  <header>
    <h1>Banana Orchestra</h1>
    <nav>
      {#if app.currentProject}
        <button onclick={() => { resolvedImageUrls = {}; deselectProject(); }}>
          &larr; Projects
        </button>
        <span class="project-name">{app.currentProject.name}</span>
        <button
          class:active-toggle={showMemoryPanel}
          onclick={() => { showMemoryPanel = !showMemoryPanel; showImageGallery = false; }}
        >
          Memory
        </button>
        <button
          class:active-toggle={showImageGallery}
          onclick={() => { showImageGallery = !showImageGallery; showMemoryPanel = false; }}
        >
          Images{app.projectImages.length > 0 ? ` (${app.projectImages.length})` : ''}
        </button>
        <button onclick={handleExportProject}>
          Export
        </button>
        <button class="delete-btn" onclick={handleDeleteProject}>
          Delete Project
        </button>
      {/if}
      <label class="debug-toggle">
        <input type="checkbox" bind:checked={showDebug} />
        Debug
      </label>
      {#if showDebug}
        <button class="debug-fault-btn" onclick={() => debugInjectFault(0)}
          title="Next turn will fail before the first API call">
          Fault R0
        </button>
        <button class="debug-fault-btn" onclick={() => debugInjectFault(1)}
          title="Next turn will fail before the second API call (after first round completes)">
          Fault R1
        </button>
      {/if}
      <button onclick={() => { showSettings = !showSettings; }}>
        Settings
      </button>
    </nav>
  </header>

  {#if showSettings}
    <div class="settings-panel">
      <h2>Settings</h2>
      <label>
        Gemini API Key
        <input
          type="password"
          bind:value={apiKeyInput}
          placeholder="Enter your Gemini API key"
        />
      </label>
      <div class="settings-actions">
        <button onclick={handleSaveSettings}>Save</button>
        <button onclick={() => { showSettings = false; }}>Cancel</button>
      </div>
    </div>
  {:else if !app.currentProject}
    <!-- Project list -->
    <div class="project-list">
      <div class="create-project">
        <input
          bind:value={newProjectName}
          placeholder="New project name..."
          onkeydown={(e) => e.key === 'Enter' && handleCreateProject()}
        />
        <button onclick={handleCreateProject} disabled={!newProjectName.trim()}>Create</button>
        <button onclick={() => importFileInput.click()}>Import</button>
        <input
          bind:this={importFileInput}
          type="file"
          accept=".zip"
          onchange={handleImportProject}
          style="display: none;"
        />
      </div>
      {#if pageStatus}
        <p class="status">{pageStatus}</p>
      {/if}
      {#if app.projects.length === 0}
        <p class="empty-state">No projects yet. Create one to get started.</p>
      {:else}
        {#each app.projects as project}
          <button class="project-card" onclick={() => handleSelectProject(project.id)}>
            <strong>{project.name}</strong>
            <span class="date">{new Date(project.updatedAt).toLocaleDateString()}</span>
          </button>
        {/each}
      {/if}
    </div>
  {:else}
    <!-- Project workspace -->
    <div class="workspace">
      <aside class="sidebar">
        <button class="new-convo" onclick={() => handleCreateConversation()}>+ New Conversation</button>
        {#each app.conversations as convo}
          <div class="convo-row" class:active={app.currentConversation?.id === convo.id}>
            <button
              class="convo-item"
              class:active={app.currentConversation?.id === convo.id}
              onclick={() => handleSelectConversation(convo.id)}
            >
              {convo.title}
            </button>
            <button
              class="convo-delete"
              onclick={(e) => { e.stopPropagation(); handleDeleteConversation(convo.id, convo.title); }}
              title="Delete conversation"
            >
              &times;
            </button>
          </div>
        {/each}
      </aside>

      {#if showMemoryPanel}
        <aside class="side-panel">
          <h3>Project Memory</h3>
          {#if app.agentMemories.length === 0}
            <p class="empty-state">No memory topics yet. The assistant will create them as your project takes shape.</p>
          {:else}
            {#each app.agentMemories as topic}
              <details class="memory-topic">
                <summary>
                  <span class="memory-title">{topic.title}</span>
                  <span class="memory-slug">{topic.slug}</span>
                </summary>
                <div class="memory-summary">{topic.summary}</div>
                <div class="memory-content">{topic.content}</div>
              </details>
            {/each}
          {/if}
        </aside>
      {/if}

      {#if showImageGallery}
        {@const userImages = app.projectImages.filter((i) => i.source === 'user')}
        {@const generatedImages = app.projectImages.filter((i) => i.source !== 'user')}
        <aside class="side-panel">
          <h3>Project Images</h3>
          {#if app.projectImages.length === 0}
            <p class="empty-state">No images yet. Ask the assistant to generate some, or upload reference material.</p>
          {/if}
          {#snippet galleryGrid(images: typeof app.projectImages)}
            <div class="image-gallery">
              {#each images as img}
                <div class="gallery-item">
                  <button
                    class="gallery-thumb"
                    onclick={() => openLightbox(img.id)}
                    title={img.label}
                  >
                    {#if resolvedImageUrls[img.id]}
                      <img src={resolvedImageUrls[img.id]} alt={img.label} />
                    {/if}
                    <span class="gallery-label">{img.label}</span>
                  </button>
                  <button
                    class="gallery-delete"
                    onclick={() => handleDeleteImage(img.id, img.label)}
                    title="Delete image"
                  >&times;</button>
                </div>
              {/each}
            </div>
          {/snippet}
          {#if userImages.length > 0}
            <h4 class="gallery-section-title">Reference</h4>
            {@render galleryGrid(userImages)}
          {/if}
          {#if generatedImages.length > 0}
            <h4 class="gallery-section-title">Generated</h4>
            {@render galleryGrid(generatedImages)}
          {/if}
        </aside>
      {/if}

      {#if showDebug}
        <aside class="debug-panel">
          <div class="debug-panel-tabs">
            <button
              class:active={debugTab === 'context'}
              onclick={() => { debugTab = 'context'; if (!contextSnapshot) takeSnapshot(); }}
            >Context</button>
            <button
              class:active={debugTab === 'log'}
              onclick={() => debugTab = 'log'}
            >Log ({turn.debugEvents.length})</button>
          </div>

          {#if debugTab === 'context'}
            <div class="debug-panel-body">
              <button class="snapshot-refresh" onclick={takeSnapshot} disabled={snapshotLoading}>
                {snapshotLoading ? 'Loading...' : 'Refresh'}
              </button>

              {#if contextSnapshot}
                <div class="snapshot-meta">
                  <div class="snapshot-time">
                    Snapshot {new Date(contextSnapshot.meta.takenAt).toLocaleTimeString()}
                  </div>
                  <div class="snapshot-meta-grid">
                    <span class="meta-label">Turns</span>
                    <span class="meta-value">{contextSnapshot.meta.turns}</span>
                    <span class="meta-label">Content entries</span>
                    <span class="meta-value">{contextSnapshot.meta.contentEntries}</span>
                    <span class="meta-label">Images</span>
                    <span class="meta-value">
                      {contextSnapshot.meta.imageCount}
                      {#if contextSnapshot.meta.imageTotalKB > 0}
                        ({contextSnapshot.meta.imageTotalKB} KB)
                      {/if}
                    </span>
                    <span class="meta-label">Tokens</span>
                    <span class="meta-value">
                      {contextSnapshot.meta.tokenCount !== null
                        ? contextSnapshot.meta.tokenCount.toLocaleString()
                        : 'unavailable'}
                    </span>
                  </div>
                  <div class="snapshot-actions">
                    <button
                      class="snapshot-copy-btn"
                      onclick={() => navigator.clipboard.writeText(contextSnapshot!.contextDump)}
                    >Copy full context</button>
                    <button
                      class="snapshot-copy-btn"
                      onclick={() => navigator.clipboard.writeText(contextSnapshot!.systemPrompt)}
                    >Copy system prompt</button>
                  </div>
                </div>

                <pre class="snapshot-dump">{contextSnapshot.contextDump}</pre>
              {:else if !snapshotLoading}
                <p class="snapshot-stat dim">Click Refresh to take a snapshot</p>
              {/if}
            </div>

          {:else}
            <div class="debug-panel-body debug-log-body">
              {#if turn.debugEvents.length === 0}
                <p class="snapshot-stat dim">No events yet. Send a message to see debug output.</p>
              {:else}
                <button class="log-clear-btn" onclick={clearDebugLog}>Clear</button>
              {/if}
              {#each turn.debugEvents as event}
                {#if event.type === 'debug_turn_boundary'}
                  <div class="log-turn-boundary">
                    <span>Turn {new Date(event.timestamp).toLocaleTimeString()}</span>
                  </div>
                {:else if event.type === 'debug_system_prompt'}
                  <details class="log-entry log-system">
                    <summary>System Prompt</summary>
                    <pre>{event.prompt}</pre>
                  </details>
                {:else if event.type === 'debug_request'}
                  <details class="log-entry log-request">
                    <summary>
                      <span class="log-badge request">REQ</span>
                      Round {event.round}
                      <span class="log-meta">{event.historyLength} msgs</span>
                    </summary>
                    <pre>{JSON.stringify(event.parts, null, 2)}</pre>
                  </details>
                {:else if event.type === 'debug_response'}
                  <details class="log-entry log-response">
                    <summary>
                      <span class="log-badge response">RES</span>
                      Round {event.round}
                      {#if event.functionCalls.length > 0}
                        <span class="log-meta">{event.functionCalls.length} tool calls</span>
                      {/if}
                    </summary>
                    {#if event.text}
                      <div class="log-subheading">Text</div>
                      <pre class="log-text">{event.text}</pre>
                    {/if}
                    {#if event.functionCalls.length > 0}
                      <div class="log-subheading">Function Calls</div>
                      <pre>{JSON.stringify(event.functionCalls, null, 2)}</pre>
                    {/if}
                  </details>
                {:else if event.type === 'debug_thought'}
                  <details class="log-entry log-thought">
                    <summary>
                      <span class="log-badge thought">THK</span>
                      Round {event.round}
                    </summary>
                    <pre class="log-thought-text">{event.text}</pre>
                  </details>
                {:else if event.type === 'debug_tool_exec'}
                  <div class="log-entry log-tool-exec">
                    <span class="log-badge tool-exec">&rarr;</span>
                    <span class="log-tool-name">{event.name}</span>
                    {#if event.name === 'generate_image' && event.args.prompt}
                      <pre class="log-gen-prompt">{event.args.prompt}</pre>
                      {#if event.args.reference_image_ids}
                        <div class="log-meta" style="width:100%">refs: {(event.args.reference_image_ids as string[]).join(', ')}</div>
                      {/if}
                    {:else}
                      <pre>{JSON.stringify(event.args, null, 2)}</pre>
                    {/if}
                  </div>
                {:else if event.type === 'debug_tool_result'}
                  <div class="log-entry log-tool-result">
                    <span class="log-badge tool-result">&larr;</span>
                    <span class="log-tool-name">{event.name}</span>
                    <pre>{JSON.stringify(event.result, null, 2)}</pre>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </aside>
      {/if}

      <!-- svelte-ignore a11y_no_static_element_interactions -->
    <main
      class="chat"
      class:dragging={isDragging}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      ondrop={handleDrop}
    >
        <div class="messages">
          {#each app.messages as msg}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="message {msg.role}" class:error-turn={msg.errorTurn} onclick={handleMessageClick}>
              <div class="message-role">
                {msg.role === 'user' ? 'You' : 'Assistant'}
                {#if msg.errorTurn}<span class="error-turn-badge">interrupted</span>{/if}
              </div>
              <div class="message-text">{@html renderMessageText(msg.text)}</div>
              {#if msg.imageIds.length > 0}
                <div class="message-images">
                  {#each msg.imageIds as imgId}
                    {#if resolvedImageUrls[imgId]}
                      <button class="image-button" onclick={() => openLightbox(imgId)}>
                        <img src={resolvedImageUrls[imgId]} alt={imgId} class="gallery-image" />
                      </button>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          {/each}

          {#if turn.streamingThought}
            <div class="message assistant">
              <div class="message-role">Thinking</div>
              <div class="message-text thought-text">{turn.streamingThought}</div>
            </div>
          {/if}

          {#if turn.streamingText}
            <div class="message assistant">
              <div class="message-role">Assistant</div>
              <div class="message-text">{@html renderMessageText(turn.streamingText)}</div>
            </div>
          {/if}

          {#if turn.statusText || pageStatus}
            <div class="status">{turn.statusText || pageStatus}</div>
          {/if}

          {#if turn.errorText}
            <div class="status error">
              {turn.errorText}
              {#if !turn.isRunning && turn.retryInput}
                <button class="retry-btn" onclick={handleRetry}>Retry</button>
              {/if}
            </div>
          {/if}

        </div>

        {#if pendingFiles.length > 0}
          <div class="pending-files">
            {#each pendingFiles as file, i}
              <div class="pending-thumb">
                <img src={getPendingFileUrl(file)} alt={file.name} />
                <button class="pending-remove" onclick={() => removePendingFile(i)}>&times;</button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="input-area">
          <button
            class="attach-btn"
            onclick={() => attachInput.click()}
            disabled={turn.isRunning || !app.settings?.geminiApiKey}
            title="Attach images"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            bind:this={attachInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
            multiple
            onchange={(e) => { const t = e.target as HTMLInputElement; if (t.files) addFiles(t.files); t.value = ''; }}
            style="display: none;"
          />
          <textarea
            bind:value={userInput}
            onkeydown={handleKeydown}
            placeholder={app.settings?.geminiApiKey ? 'Describe what you want to create...' : 'Set your API key in Settings first'}
            disabled={turn.isRunning || !app.settings?.geminiApiKey}
            rows={3}
          ></textarea>
          {#if turn.isRunning}
            <button class="cancel-btn" onclick={cancelTurn}>Cancel</button>
          {:else}
            <button onclick={() => handleSend()} disabled={!userInput.trim() && pendingFiles.length === 0}>Send</button>
          {/if}
        </div>
      </main>
    </div>
  {/if}
</div>

{#if lightboxImageId && resolvedImageUrls[lightboxImageId]}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox" onclick={closeLightbox} onkeydown={handleLightboxKeydown}>
    <button class="lightbox-close" onclick={closeLightbox}>&times;</button>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="lightbox-content" onclick={(e) => e.stopPropagation()}>
      <img src={resolvedImageUrls[lightboxImageId]} alt="Full size preview" />
      {#if lightboxImage}
        <div class="lightbox-info">
          <span class="lightbox-label">{lightboxImage.label}</span>
          {#if lightboxImage.generationContext}
            <span class="lightbox-context">{lightboxImage.generationContext}</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0a;
    color: #e0e0e0;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.5rem;
    background: #141414;
    border-bottom: 1px solid #222;
  }

  header h1 {
    font-size: 1.1rem;
    margin: 0;
    color: #f5c542;
  }

  nav {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .project-name {
    color: #999;
  }

  button {
    background: #1e1e1e;
    color: #e0e0e0;
    border: 1px solid #333;
    padding: 0.4rem 0.8rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
  }

  button:hover:not(:disabled) {
    background: #2a2a2a;
    border-color: #444;
  }

  button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Settings */
  .settings-panel {
    max-width: 400px;
    margin: 2rem auto;
    padding: 1.5rem;
  }

  .settings-panel h2 {
    margin-top: 0;
  }

  .settings-panel label {
    display: block;
    margin-bottom: 1rem;
  }

  .settings-panel input {
    display: block;
    width: 100%;
    margin-top: 0.25rem;
    padding: 0.5rem;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    color: #e0e0e0;
    box-sizing: border-box;
  }

  .settings-actions {
    display: flex;
    gap: 0.5rem;
  }

  /* Project list */
  .project-list {
    max-width: 500px;
    margin: 2rem auto;
    padding: 0 1rem;
  }

  .create-project {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .create-project input {
    flex: 1;
    padding: 0.5rem;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    color: #e0e0e0;
  }

  .empty-state {
    color: #666;
    text-align: center;
    padding: 2rem 0;
  }

  .project-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 0.75rem;
    margin-bottom: 0.5rem;
    text-align: left;
  }

  .date {
    color: #666;
    font-size: 0.8rem;
  }

  /* Workspace */
  .workspace {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .sidebar {
    width: 220px;
    background: #111;
    border-right: 1px solid #222;
    padding: 0.5rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .new-convo {
    border-color: #f5c542;
    color: #f5c542;
    margin-bottom: 0.5rem;
  }

  .convo-row {
    display: flex;
    align-items: center;
    border-radius: 4px;
  }

  .convo-row:hover .convo-delete {
    opacity: 1;
  }

  .convo-item {
    flex: 1;
    text-align: left;
    border: none;
    background: transparent;
    padding: 0.5rem;
    border-radius: 4px;
    color: #aaa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .convo-item:hover {
    background: #1a1a1a;
    color: #e0e0e0;
  }

  .convo-item.active {
    background: #1e1e1e;
    color: #f5c542;
  }

  .convo-delete {
    opacity: 0;
    background: none;
    border: none;
    color: #666;
    font-size: 1rem;
    padding: 0.25rem 0.4rem;
    cursor: pointer;
    flex-shrink: 0;
  }

  .convo-delete:hover {
    color: #e55;
  }

  .delete-btn {
    color: #e55;
    border-color: #e55;
  }

  .delete-btn:hover:not(:disabled) {
    background: #2a1515;
  }

  /* Side Panels (Design Doc, Image Gallery) */
  .side-panel {
    width: 320px;
    background: #111;
    border-left: 1px solid #222;
    padding: 1rem;
    overflow-y: auto;
    order: 1;
  }

  .side-panel h3 {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
    color: #f5c542;
  }

  .memory-topic {
    border: 1px solid #222;
    border-radius: 6px;
    margin-bottom: 0.5rem;
  }

  .memory-topic summary {
    padding: 0.5rem 0.6rem;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    user-select: none;
  }

  .memory-topic summary:hover {
    background: #1a1a1a;
  }

  .memory-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: #ddd;
  }

  .memory-slug {
    font-size: 0.7rem;
    color: #666;
    font-family: monospace;
  }

  .memory-summary {
    padding: 0.25rem 0.6rem 0.4rem;
    font-size: 0.78rem;
    color: #999;
    border-bottom: 1px solid #1a1a1a;
  }

  .memory-content {
    padding: 0.5rem 0.6rem;
    font-size: 0.82rem;
    line-height: 1.5;
    white-space: pre-wrap;
    color: #bbb;
    max-height: 20rem;
    overflow-y: auto;
  }

  .active-toggle {
    border-color: #f5c542;
    color: #f5c542;
  }

  /* Image Gallery */
  .gallery-section-title {
    font-size: 0.75rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0.75rem 0 0.4rem;
  }

  .gallery-section-title:first-of-type {
    margin-top: 0;
  }

  .image-gallery {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .gallery-item {
    position: relative;
  }

  .gallery-item:hover .gallery-delete {
    opacity: 1;
  }

  .gallery-delete {
    position: absolute;
    top: 2px;
    right: 2px;
    opacity: 0;
    background: rgba(0, 0, 0, 0.7);
    border: none;
    color: #fff;
    font-size: 0.9rem;
    padding: 0 0.35rem;
    cursor: pointer;
    line-height: 1.4;
    border-radius: 4px;
    z-index: 1;
  }

  .gallery-delete:hover {
    background: #e55;
  }

  .gallery-thumb {
    background: none;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0;
    cursor: pointer;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .gallery-thumb:hover {
    border-color: #f5c542;
  }

  .gallery-thumb img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    display: block;
  }

  .gallery-label {
    font-size: 0.7rem;
    color: #aaa;
    padding: 0.25rem 0.4rem;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .image-button {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    border-radius: 6px;
    overflow: hidden;
  }

  .image-button:hover {
    outline: 2px solid #f5c542;
  }

  /* Chat */
  .chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 80ch;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  .message {
    max-width: 100%;
  }

  .message-role {
    font-size: 0.75rem;
    color: #666;
    margin-bottom: 0.25rem;
  }

  .message-text {
    background: #1a1a1a;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    line-height: 1.5;
  }

  .message-text :global(p) {
    margin: 0 0 0.5rem;
  }

  .message-text :global(p:last-child) {
    margin-bottom: 0;
  }

  .message-text :global(pre) {
    background: #111;
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.85rem;
  }

  .message-text :global(code) {
    background: #111;
    padding: 0.15rem 0.3rem;
    border-radius: 3px;
    font-size: 0.85em;
  }

  .message-text :global(pre code) {
    background: none;
    padding: 0;
  }

  .message-text :global(ul), .message-text :global(ol) {
    margin: 0.25rem 0 0.5rem;
    padding-left: 1.5rem;
  }

  .message-text :global(h1), .message-text :global(h2), .message-text :global(h3) {
    margin: 0.75rem 0 0.25rem;
    font-size: 1rem;
  }

  .message-text :global(blockquote) {
    border-left: 3px solid #444;
    margin: 0.5rem 0;
    padding-left: 0.75rem;
    color: #aaa;
  }

  .message.user .message-text {
    background: #1a2a1a;
  }

  .message.error-turn {
    opacity: 0.6;
  }

  .message.error-turn .message-text {
    border-left: 3px solid #e55;
  }

  .error-turn-badge {
    color: #e55;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-left: 0.4rem;
  }

  .thought-text {
    background: #1a1a22;
    color: #8888bb;
    font-size: 0.85rem;
    border-left: 2px solid #4444aa;
  }

  .message-images {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
  }

  :global(.image-missing) {
    display: inline-block;
    color: #e55;
    font-size: 0.8rem;
    padding: 0.15rem 0.4rem;
    border: 1px solid #e55;
    border-radius: 3px;
    opacity: 0.7;
  }

  :global(.inline-image) {
    max-width: 300px;
    max-height: 300px;
    border-radius: 6px;
    display: block;
    margin: 0.5rem 0;
  }

  .gallery-image {
    max-width: 300px;
    max-height: 300px;
    border-radius: 6px;
  }

  .status {
    color: #f5c542;
    font-size: 0.85rem;
    padding: 0.5rem;
  }

  .status.error {
    color: #e55;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .retry-btn {
    background: #2a1515;
    color: #e55;
    border: 1px solid #e55;
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
    flex-shrink: 0;
  }

  .retry-btn:hover {
    background: #3a1a1a;
    color: #ff7777;
    border-color: #ff7777;
  }

  .chat.dragging {
    outline: 2px dashed #f5c542;
    outline-offset: -4px;
  }

  .pending-files {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 1.5rem 0;
    background: #111;
    border-top: 1px solid #222;
    flex-wrap: wrap;
  }

  .pending-thumb {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid #333;
  }

  .pending-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .pending-remove {
    position: absolute;
    top: 0;
    right: 0;
    background: rgba(0, 0, 0, 0.7);
    border: none;
    color: #fff;
    font-size: 0.8rem;
    padding: 0 0.3rem;
    cursor: pointer;
    line-height: 1.4;
    border-radius: 0 0 0 4px;
  }

  .pending-remove:hover {
    background: #e55;
  }

  .attach-btn {
    align-self: flex-end;
    background: none;
    border: 1px solid #444;
    color: #999;
    padding: 0.45rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .attach-btn:hover:not(:disabled) {
    color: #f5c542;
    border-color: #f5c542;
  }

  .input-area {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    border-top: 1px solid #222;
    background: #111;
  }

  .input-area textarea {
    flex: 1;
    resize: none;
    padding: 0.5rem;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 6px;
    color: #e0e0e0;
    font-family: inherit;
    font-size: 0.9rem;
  }

  .input-area textarea:focus {
    outline: none;
    border-color: #f5c542;
  }

  .input-area button {
    align-self: flex-end;
    padding: 0.5rem 1.5rem;
    background: #f5c542;
    color: #0a0a0a;
    border: none;
    font-weight: 600;
  }

  .input-area button:hover:not(:disabled) {
    background: #f0b820;
  }

  .input-area .cancel-btn {
    background: #e55;
    color: #fff;
  }

  .input-area .cancel-btn:hover {
    background: #ff4444;
  }

  /* Lightbox */
  :global(.lightbox) {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.9);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  :global(.lightbox-close) {
    position: absolute;
    top: 1rem;
    right: 1rem;
    background: none;
    border: none;
    color: #fff;
    font-size: 2rem;
    cursor: pointer;
    z-index: 101;
    line-height: 1;
    padding: 0.25rem 0.5rem;
  }

  :global(.lightbox-close:hover) {
    color: #f5c542;
  }

  :global(.lightbox-content) {
    cursor: default;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  :global(.lightbox-content img) {
    max-width: 90vw;
    max-height: 80vh;
    object-fit: contain;
    border-radius: 4px;
  }

  :global(.lightbox-info) {
    margin-top: 0.75rem;
    text-align: center;
    max-width: 60ch;
  }

  :global(.lightbox-label) {
    display: block;
    color: #fff;
    font-size: 0.95rem;
    font-weight: 600;
  }

  :global(.lightbox-context) {
    display: block;
    color: #999;
    font-size: 0.8rem;
    margin-top: 0.25rem;
    line-height: 1.4;
  }

  /* Debug toggle */
  .debug-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: #888;
    font-size: 0.8rem;
    cursor: pointer;
    user-select: none;
  }

  .debug-toggle input {
    accent-color: #f5c542;
  }

  .debug-fault-btn {
    background: #2a1515;
    color: #e55;
    border-color: #e55;
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
  }

  .debug-fault-btn:hover:not(:disabled) {
    background: #3a1a1a;
  }

  /* Debug panel */
  .debug-panel {
    width: 400px;
    background: #0d0d0d;
    border-left: 1px solid #222;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    order: 2;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 0.78rem;
  }

  .debug-panel-tabs {
    display: flex;
    border-bottom: 1px solid #222;
    flex-shrink: 0;
  }

  .debug-panel-tabs button {
    flex: 1;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #888;
    padding: 0.5rem;
    font-size: 0.78rem;
    font-family: inherit;
    cursor: pointer;
    border-radius: 0;
  }

  .debug-panel-tabs button:hover {
    color: #ccc;
    background: #111;
  }

  .debug-panel-tabs button.active {
    color: #f5c542;
    border-bottom-color: #f5c542;
  }

  .debug-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
  }

  /* Context snapshot styles */
  .snapshot-refresh {
    width: 100%;
    margin-bottom: 0.5rem;
    font-family: inherit;
    font-size: 0.75rem;
  }

  .snapshot-meta {
    border-bottom: 1px solid #1a1a1a;
    padding-bottom: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .snapshot-time {
    color: #666;
    font-size: 0.7rem;
    margin-bottom: 0.5rem;
  }

  .snapshot-meta-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.75rem;
    margin-bottom: 0.5rem;
  }

  .meta-label {
    color: #888;
    font-size: 0.72rem;
  }

  .meta-value {
    color: #ccc;
    font-size: 0.72rem;
  }

  .snapshot-actions {
    display: flex;
    gap: 0.4rem;
  }

  .snapshot-copy-btn {
    font-family: inherit;
    font-size: 0.68rem;
    padding: 0.15rem 0.5rem;
  }

  .snapshot-stat.dim, .dim {
    color: #555;
  }

  .snapshot-dump {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: #aaa;
    line-height: 1.5;
    font-size: 0.72rem;
  }

  /* Debug log styles */
  .debug-log-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .log-clear-btn {
    align-self: flex-end;
    font-family: inherit;
    font-size: 0.68rem;
    padding: 0.15rem 0.5rem;
    margin-bottom: 0.25rem;
  }

  .log-turn-boundary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #555;
    font-size: 0.68rem;
    margin: 0.25rem 0;
  }

  .log-turn-boundary::before,
  .log-turn-boundary::after {
    content: '';
    flex: 1;
    border-top: 1px dashed #333;
  }

  .log-entry {
    border-left: 3px solid #333;
    padding: 0.35rem 0.5rem;
    border-radius: 0 3px 3px 0;
    background: #111;
  }

  .log-entry summary {
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    list-style: none;
  }

  .log-entry summary::-webkit-details-marker {
    display: none;
  }

  .log-entry pre {
    margin: 0.3rem 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: #999;
    max-height: 20rem;
    overflow-y: auto;
    line-height: 1.4;
    font-size: 0.72rem;
  }

  .log-badge {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .log-badge.thought {
    background: #1a1a30;
    color: #8888bb;
  }

  .log-badge.request {
    background: #1a2040;
    color: #6688cc;
  }

  .log-badge.response {
    background: #1a3020;
    color: #66bb66;
  }

  .log-badge.tool-exec {
    background: #2a1a30;
    color: #aa66cc;
  }

  .log-badge.tool-result {
    background: #301a1a;
    color: #cc8866;
  }

  .log-system {
    border-left-color: #665500;
  }

  .log-thought {
    border-left-color: #44a;
  }

  .log-thought-text {
    color: #8888bb;
  }

  .log-request {
    border-left-color: #336;
  }

  .log-response {
    border-left-color: #363;
  }

  .log-tool-exec {
    border-left-color: #636;
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .log-tool-result {
    border-left-color: #633;
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .log-tool-name {
    color: #ccc;
    font-weight: 600;
    font-size: 0.75rem;
  }

  .log-tool-exec pre,
  .log-tool-result pre {
    width: 100%;
  }

  .log-meta {
    color: #666;
    font-size: 0.68rem;
    margin-left: auto;
  }

  .log-gen-prompt {
    color: #dda;
    background: #1a1a10;
    border: 1px solid #333020;
    border-radius: 3px;
    padding: 0.35rem 0.5rem;
    width: 100%;
  }

  .log-subheading {
    color: #888;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-top: 0.3rem;
    margin-bottom: 0.15rem;
  }

  .log-text {
    color: #8cbf8c;
  }
</style>
