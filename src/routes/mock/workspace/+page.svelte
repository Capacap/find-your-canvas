<script lang="ts">
  import '$lib/styles/tokens.css';
  import { marked } from 'marked';
  import { onMount } from 'svelte';

  marked.setOptions({ breaks: true, gfm: true });
  import {
    getAppState,
    loadSettings,
    loadProjects,
    saveSettings,
    selectProject,
    deselectProject,
    selectConversation,
    createProject,
    createConversation,
    deleteConversation,
    renameConversation,
    toggleFavorite as storeToggleFavorite,
    getImageUrl,
    revokeImageUrls,
    refreshMessages,
  } from '$lib/stores/appState.svelte';
  import {
    getTurnState,
    sendMessage,
    retryMessage,
    rollbackTurn,
    cancelTurn,
    clearTurnError,
    clearDebugLog,
    simulateTurn,
    simulateFullTurn,
    type SimulationStep,
  } from '$lib/stores/turnState.svelte';

  const app = getAppState();
  const turn = getTurnState();

  // Local UI state
  type SidebarView = 'conversations' | 'images' | 'memories' | 'settings';
  type CanvasView = 'chat' | 'gallery' | 'memories';
  let activeView = $state<SidebarView>('conversations');
  let canvasView = $state<CanvasView>('chat');
  let sidebarOpen = $state(true);
  let inputText = $state('');
  let isDragging = $state(false);
  let isRollingBack = $state(false);
  let rollbackImageIds = $state<string[]>([]);
  let pendingUserText = $state<string | null>(null);
  let chatScrollEl = $state<HTMLElement | null>(null);
  let activityExpanded = $state(false);
  let apiKeyInput = $state('');

  // ── Debug panel state ──
  let debugPanelOpen = $state(false);
  let layoutShifts = $state<Array<{ time: number; value: number; sources: string[] }>>([]);
  let scrollMetrics = $state({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, spacerHeight: 0 });
  let roFireCount = $state(0);

  // Sync API key input with store
  $effect.pre(() => {
    apiKeyInput = app.settings?.geminiApiKey ?? '';
  });

  // File attachments (pending upload)
  type PendingFile = { id: string; file: File; previewUrl: string };
  let pendingFiles = $state<PendingFile[]>([]);
  const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

  function addFiles(files: FileList | File[]) {
    for (const file of files) {
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) continue;
      pendingFiles = [...pendingFiles, {
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      }];
    }
  }

  function removeAttachment(id: string) {
    const removed = pendingFiles.find(f => f.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    pendingFiles = pendingFiles.filter(f => f.id !== id);
  }

  // Drag-drop handlers
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

  // Resolved image URLs (blob object URLs from IndexedDB)
  let resolvedImageUrls = $state<Record<string, string>>({});
  const resolveInflight = new Set<string>();

  async function resolveImageId(id: string) {
    if (resolveInflight.has(id)) return;
    resolveInflight.add(id);
    try {
      const url = await getImageUrl(id);
      if (url) resolvedImageUrls = { ...resolvedImageUrls, [id]: url };
    } finally {
      resolveInflight.delete(id);
    }
  }

  // Resolve images referenced in messages
  $effect(() => {
    for (const msg of app.messages) {
      for (const imgId of msg.imageIds) resolveImageId(imgId);
    }
  });

  // Resolve images in the project gallery
  $effect(() => {
    for (const img of app.projectImages) resolveImageId(img.id);
  });

  // Favorite set derived from projectImages
  let favorites = $derived(new Set(
    app.projectImages.filter(img => img.favorite).map(img => img.id)
  ));

  async function toggleFavorite(imageId: string) {
    await storeToggleFavorite(imageId);
  }

  // Image label lookup
  let imageLabelMap = $derived(
    new Map(app.projectImages.map(img => [img.id, img.label]))
  );

  // Lightbox
  let lightboxImageId = $state<string | null>(null);
  let lightboxImage = $derived(app.projectImages.find(img => img.id === lightboxImageId));

  function openLightbox(imageId: string) {
    lightboxImageId = imageId;
  }

  function closeLightbox() {
    lightboxImageId = null;
  }

  function handleLightboxKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeLightbox();
  }

  // Images sorted newest-first for sidebar and gallery
  let imagesByRecency = $derived(
    [...app.projectImages].sort((a, b) => b.createdAt - a.createdAt)
  );

  // Suggested replies: parse from last assistant message
  const SUGGESTED_REPLIES_EXTRACT_RE = /<suggested-replies>\s*([\s\S]*?)\s*<\/suggested-replies>/;
  const SUGGESTED_REPLIES_STRIP_RE = /<suggested-replies>\s*[\s\S]*?\s*<\/suggested-replies>/g;

  function extractSuggestedReplies(text: string): string[] {
    const match = text.match(SUGGESTED_REPLIES_EXTRACT_RE);
    if (!match) return [];
    return match[1]
      .split('\n')
      .map(line => line.replace(/^-\s*/, '').replace(/^[""]|[""]$/g, '').trim())
      .filter(Boolean);
  }

  function stripSuggestedReplies(text: string): string {
    return text
      .replace(SUGGESTED_REPLIES_STRIP_RE, '')
      .replace(/<suggested-replies[\s\S]*$/, '')
      .trimEnd();
  }

  let suggestedReplies = $derived.by(() => {
    const msgs = app.messages;
    if (msgs.length === 0 || turn.isRunning) return [];
    const last = msgs[msgs.length - 1];
    if (last.role !== 'assistant') return [];
    return extractSuggestedReplies(last.text);
  });

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMessageText(text: string): string {
    const stripped = stripSuggestedReplies(text);
    const withImages = stripped.replace(
      /\[image:([^\]]+)\]/g,
      (_, id) => {
        const label = imageLabelMap.get(id) ?? id.slice(0, 8);
        return `<span class="image-chip" data-image-id="${id}">${escapeHtml(label)}</span>`;
      }
    );
    return marked.parse(withImages, { async: false }) as string;
  }

  function handleSuggestedReply(text: string) {
    inputText = text;
    handleSend();
  }

  function handleMessageClick(e: MouseEvent) {
    const chip = (e.target as HTMLElement).closest('[data-image-id]') as HTMLElement | null;
    if (chip?.dataset.imageId) openLightbox(chip.dataset.imageId);
  }

  // Initialization
  onMount(async () => {
    await loadSettings();
    await loadProjects();
    if (app.projects.length > 0 && !app.currentProject) {
      await selectProject(app.projects[0].id);
    }

    // Layout Instability API: detect which elements cause layout shifts.
    if ('PerformanceObserver' in window) {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number; sources?: Array<{ node?: Node }> })[]) {
          const sources = (entry.sources ?? [])
            .map((s) => {
              const el = s.node as HTMLElement | null;
              if (!el) return '(unknown)';
              const tag = el.tagName?.toLowerCase() ?? '?';
              const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
              return `${tag}${cls}`;
            });
          layoutShifts = [...layoutShifts, {
            time: Math.round(entry.startTime),
            value: Math.round(entry.value * 10000) / 10000,
            sources
          }];
          console.warn('[layout-shift]', entry.value.toFixed(4), sources.join(', '));
        }
      });
      po.observe({ type: 'layout-shift', buffered: false });
    }
  });

  // Project actions
  async function handleSelectProject(id: string) {
    resolvedImageUrls = {};
    revokeImageUrls();
    await selectProject(id);
  }

  function handleDeselectProject() {
    resolvedImageUrls = {};
    deselectProject();
  }

  // System notice detection (agent-first conversation initiation)
  const AGENT_FIRST_MESSAGE = '<system-notice>The user is starting a new session and wants you to take initiative and get the session rolling. Read project memory if available, review existing images, then recommend an initial topic to discuss. For a new project with no context yet, introduce yourself briefly and ask what the user wants to explore.</system-notice>';

  function isSystemNotice(text: string): boolean {
    const t = text.trim();
    return t.startsWith('<system-notice>') && t.endsWith('</system-notice>');
  }

  async function handleAgentFirst() {
    if (!app.currentProject) {
      await createProject('Untitled project', false);
    }
    if (!app.currentConversation) {
      await createConversation('New conversation');
    }
    await sendMessage({ text: AGENT_FIRST_MESSAGE, onImageGenerated: (id) => resolveImageId(id) });
  }

  // Conversation actions
  async function handleSelectConversation(id: string) {
    canvasView = 'chat';
    clearDebugLog();
    clearTurnError();
    await selectConversation(id);
  }

  async function handleNewChat() {
    if (!app.currentProject) return;
    clearTurnError();
    await createConversation('New conversation');
    canvasView = 'chat';
  }

  async function handleDeleteConversation(id: string) {
    await deleteConversation(id);
  }

  // Send message
  async function handleSend() {
    const text = inputText.trim();
    if (!text && pendingFiles.length === 0) return;

    // Auto-create conversation if none selected
    if (!app.currentConversation) {
      if (!app.currentProject) {
        await createProject('Untitled project', false);
      }
      await createConversation(text.slice(0, 60) || 'New conversation');
    }

    // Auto-rename "New conversation" on first real message
    if (app.currentConversation?.title === 'New conversation' && text && !isSystemNotice(text)) {
      await renameConversation(app.currentConversation.id, text.slice(0, 60));
    }

    const files = pendingFiles.map(f => f.file);
    const reattach = rollbackImageIds;
    inputText = '';
    rollbackImageIds = [];
    for (const pf of pendingFiles) URL.revokeObjectURL(pf.previewUrl);
    pendingFiles = [];
    if (!isSystemNotice(text)) {
      pendingUserText = text;
      // Double-rAF: first lets Svelte render the DOM, second lets layout complete
      requestAnimationFrame(() => requestAnimationFrame(anchorToUserMessage));
    }

    await sendMessage({
      text,
      files: files.length > 0 ? files : undefined,
      reattachImageIds: reattach.length > 0 ? reattach : undefined,
      onImageGenerated: (imageId) => resolveImageId(imageId),
    });
    pendingUserText = null;
  }

  // Retry / Rollback / Cancel
  async function handleRetry() {
    clearTurnError();
    await retryMessage((imageId) => resolveImageId(imageId));
  }

  async function handleRollback() {
    if (isRollingBack) return;
    isRollingBack = true;
    try {
      const result = await rollbackTurn();
      if (result && !isSystemNotice(result.userText)) {
        inputText = result.userText;
        rollbackImageIds = result.userImageIds;
      }
    } finally {
      isRollingBack = false;
    }
  }

  function handleCancel() {
    cancelTurn();
  }

  // Settings
  async function handleSaveSettings() {
    await saveSettings({ geminiApiKey: apiKeyInput });
  }

  // Scroll tracking (shared by chat and sidebar)
  function trackScroll(node: HTMLElement) {
    const parent = node.parentElement!;
    function update() {
      const atTop = node.scrollTop <= 2;
      const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
      parent.classList.toggle('at-top', atTop);
      parent.classList.toggle('at-bottom', atBottom);
    }
    update();
    node.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return {
      destroy() {
        node.removeEventListener('scroll', update);
        ro.disconnect();
      }
    };
  }

  // ── Chat auto-scroll ──
  //
  // Scroll management with geometry-based spacer.
  //
  // A spacer div sits at the bottom of the chat column. Its height is
  // calculated so that when you scroll all the way down, the last user
  // message sits at the top of the viewport. As the assistant response
  // grows, the spacer shrinks automatically. When enough content exists
  // below the user message to fill the viewport, the spacer reaches zero.
  //
  // This eliminates turn-lifecycle transitions: the spacer is always
  // present, sized purely by content geometry.

  let spacerEl = $state<HTMLElement | null>(null);

  function trackChatScroll(node: HTMLElement) {
    chatScrollEl = node;
    const parent = node.parentElement!;
    function update() {
      const atTop = node.scrollTop <= 2;
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      const atBottom = gap <= 2;

      parent.classList.toggle('at-top', atTop);
      parent.classList.toggle('at-bottom', atBottom);
    }
    update();
    // Update debug scroll metrics on scroll.
    function updateDebugMetrics() {
      scrollMetrics = {
        scrollTop: Math.round(node.scrollTop),
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        spacerHeight: spacerEl?.offsetHeight ?? 0
      };
    }
    node.addEventListener('scroll', () => { update(); updateDebugMetrics(); }, { passive: true });
    // RO handles fade-overlay classes only. updateSpacer() is deliberately
    // NOT called here: content reflows (details toggle, suggested replies)
    // change the input area height, which changes clientHeight, which would
    // trigger spacer recalculation and cause scroll jumps. Spacer updates
    // come from the $effect (message/streaming changes) and window resize.
    const ro = new ResizeObserver(() => {
      roFireCount++;
      update();
      updateDebugMetrics();
    });
    ro.observe(node);
    function onWindowResize() {
      updateSpacer();
      updateDebugMetrics();
    }
    window.addEventListener('resize', onWindowResize);
    return {
      destroy() {
        node.removeEventListener('scroll', update);
        ro.disconnect();
        window.removeEventListener('resize', onWindowResize);
        chatScrollEl = null;
      }
    };
  }

  /**
   * Resize the spacer so the last user message sits at the same vertical
   * position as the first message when scrolled to the top.
   *
   * Subtracts the current spacer height from scrollHeight to derive the
   * natural content height without zeroing the spacer (which would cause
   * the browser to clamp scrollTop and produce scroll jumps).
   */
  function updateSpacer() {
    if (!spacerEl || !chatScrollEl) return;
    const chatColumn = spacerEl.parentElement!;
    const userMessages = chatColumn.querySelectorAll('.message.user');
    const lastUser = userMessages[userMessages.length - 1] as HTMLElement | null;
    if (!lastUser) {
      spacerEl.style.height = '0px';
      return;
    }
    const topPad = parseFloat(getComputedStyle(chatScrollEl).paddingTop);
    const currentSpacerH = spacerEl.offsetHeight;
    const naturalScrollH = chatScrollEl.scrollHeight - currentSpacerH;
    const targetScrollH = lastUser.offsetTop - topPad + chatScrollEl.clientHeight;
    spacerEl.style.height = `${Math.max(0, targetScrollH - naturalScrollH)}px`;
  }

  function anchorToUserMessage() {
    if (!chatScrollEl) return;
    // Prefer the optimistic pending-message anchor; fall back to the last persisted user message.
    const anchor = (
      chatScrollEl.querySelector('[data-turn-anchor]') ??
      [...chatScrollEl.querySelectorAll('.message.user')].at(-1)
    ) as HTMLElement | null;
    if (!anchor) return;
    updateSpacer();
    const topPad = parseFloat(getComputedStyle(chatScrollEl).paddingTop);
    anchor.style.scrollMarginTop = `${topPad}px`;
    anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  $effect(() => {
    // Recalculate spacer when the persisted message list changes or a
    // pending user message appears.
    //
    // Skip during a running turn or settling: anchorToUserMessage()
    // handles scroll positioning at turn start, and the spacer should
    // not move while content is streaming or during the handoff.
    // Window resizes are handled by a dedicated resize listener.
    app.messages;
    pendingUserText;

    if (!turn.isRunning && !turn.isSettling) updateSpacer();
  });

  // ── Debug: fake message helpers ──

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

  /** A scripted turn that exercises all the activity log states. */
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

  function debugClearShifts() {
    layoutShifts = [];
    roFireCount = 0;
  }
</script>

<div class="app">
  <div class="workspace">
      <!-- Activity bar + Sidebar -->
      {#if sidebarOpen}
      <nav class="activity-bar">
        <div class="activity-top">
      <button
        class="activity-btn"
        class:active={activeView === 'conversations'}
        onclick={() => activeView = 'conversations'}
        title="Conversations"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </button>
      <button
        class="activity-btn"
        class:active={activeView === 'images'}
        onclick={() => activeView = 'images'}
        title="Images"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </button>
      <button
        class="activity-btn"
        class:active={activeView === 'memories'}
        onclick={() => activeView = 'memories'}
        title="Memories"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
          <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
        </svg>
      </button>
      <button
        class="activity-btn"
        class:active={activeView === 'settings'}
        onclick={() => activeView = 'settings'}
        title="Settings"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      </button>
        </div>
      </nav>

      <!-- Sidebar: content changes based on active view -->
      <aside class="sidebar">
        {#if activeView === 'conversations'}
      <div class="fade-container">
        <div class="fade-top"></div>
        <div class="sidebar-scroll" use:trackScroll>
          <button class="sidebar-item sidebar-new-chat" onclick={handleNewChat}>
            <span class="sidebar-item-name">+ New chat</span>
          </button>
          {#each app.conversations as convo}
            <button
              class="sidebar-item"
              class:active={convo.id === app.currentConversation?.id}
              onclick={() => handleSelectConversation(convo.id)}
            >
              <span class="sidebar-item-name">{convo.title}</span>
            </button>
          {/each}
        </div>
        <div class="fade-bottom"></div>
      </div>

    {:else if activeView === 'images'}
      <button class="sidebar-action" onclick={() => canvasView = 'gallery'}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
        Open gallery
      </button>
      <div class="fade-container">
        <div class="fade-top"></div>
        <div class="sidebar-scroll queue-grid" use:trackScroll>
          {#each imagesByRecency as img}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="queue-item" onclick={() => openLightbox(img.id)}>
              <div class="queue-thumb">
                {#if resolvedImageUrls[img.id]}
                  <img src={resolvedImageUrls[img.id]} alt={img.label} />
                {:else}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                {/if}
                <button
                  class="fav-btn queue-fav"
                  class:favorited={favorites.has(img.id)}
                  onclick={(e) => { e.stopPropagation(); toggleFavorite(img.id); }}
                  title={favorites.has(img.id) ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={favorites.has(img.id) ? 'currentColor' : 'none'}>
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                </button>
              </div>
              <span class="queue-label">{img.label}</span>
            </div>
          {/each}
        </div>
        <div class="fade-bottom"></div>
      </div>

    {:else if activeView === 'memories'}
      <div class="fade-container">
        <div class="fade-top"></div>
        <div class="sidebar-scroll" use:trackScroll>
          {#each app.agentMemories as mem}
            <button class="sidebar-item" onclick={() => canvasView = 'memories'}>
              <span class="sidebar-item-name">{mem.title}</span>
            </button>
          {/each}
        </div>
        <div class="fade-bottom"></div>
      </div>

    {:else if activeView === 'settings'}
      <div class="settings-sidebar">
        <label class="settings-label">
          <span class="settings-label-text">Gemini API Key</span>
          <input
            class="settings-input"
            type="password"
            bind:value={apiKeyInput}
            placeholder="Enter your Gemini API key"
          />
        </label>
        <button class="settings-save-btn" onclick={handleSaveSettings}>Save</button>
        {#if app.projects.length > 1}
          <div class="settings-divider"></div>
          <span class="settings-label-text">Switch project</span>
          {#each app.projects as project}
            <button
              class="sidebar-item"
              class:active={project.id === app.currentProject?.id}
              onclick={() => handleSelectProject(project.id)}
            >
              <span class="sidebar-item-name">{project.name}</span>
            </button>
          {/each}
        {/if}
      </div>
        {/if}
      </aside>
      {/if}

    <!-- Center: canvas -->
    <main
      class="canvas"
      class:dragging={isDragging}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      ondrop={handleDrop}
    >
      <div class="canvas-header">
        <button class="sidebar-toggle" onclick={() => sidebarOpen = !sidebarOpen} title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        {#if canvasView !== 'chat'}
          <button class="back-btn" onclick={() => canvasView = 'chat'} title="Back to chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
        {/if}
        {#if canvasView === 'chat'}
          {#if app.currentProject}
            <span class="canvas-header-link">{app.currentProject.name}</span>
          {/if}
          {#if app.currentConversation}
            <span class="canvas-header-sep">/</span>
            <span class="canvas-header-title">{app.currentConversation.title}</span>
          {/if}
        {:else if canvasView === 'gallery'}
          <span class="canvas-header-title">Image Gallery</span>
        {:else if canvasView === 'memories'}
          <span class="canvas-header-title">Memories</span>
        {/if}
      </div>

      {#if canvasView === 'chat'}
        <div class="fade-container">
          <div class="fade-top"></div>
          <div class="scroll-content" use:trackChatScroll>
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="chat-column" onclick={handleMessageClick}>
              {#if app.messages.length === 0 && !turn.isRunning && app.settings?.geminiApiKey}
                <div class="agent-first-prompt">
                  <button class="agent-first-btn" onclick={handleAgentFirst}>
                    Let the assistant start
                  </button>
                </div>
              {/if}
              {#each app.messages as msg, i}
                {@const isLastAssistant = msg.role === 'assistant' && !app.messages.slice(i + 1).some((m: { role: string }) => m.role === 'assistant')}
                {#if isLastAssistant && turn.isSettling}
                  <!-- hidden during settle: streaming block still covers this message -->
                {:else if msg.role === 'user' && isSystemNotice(msg.text)}
                  <!-- hidden: agent-first initiation message -->
                {:else}
                <div class="message" class:user={msg.role === 'user'} class:assistant={msg.role === 'assistant'} class:last-assistant={isLastAssistant}>
                  {#if msg.role === 'assistant' && msg.activityLog?.length}
                    {@const log = msg.activityLog}
                    {@const lastLogEntry = log[log.length - 1]}
                    {#if log.length === 1}
                      <div class="persisted-activity">
                        <div class="activity-summary-static">
                          <span class="activity-dot static"></span>
                          {lastLogEntry.text}
                        </div>
                      </div>
                    {:else}
                      <details
                        class="persisted-activity"
                        open={isLastAssistant && !turn.isRunning && activityExpanded ? true : undefined}
                        ontoggle={(e) => {
                          if (isLastAssistant && !turn.isRunning) activityExpanded = e.currentTarget.open;
                        }}
                      >
                        <summary>
                          <span class="activity-dot static"></span>
                          {lastLogEntry.text}
                          <span class="activity-chevron-icon">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </span>
                        </summary>
                        <div class="activity-log">
                          {#each log as entry}
                            <div class="activity-log-entry" class:nested={entry.nested}>
                              {entry.text}
                            </div>
                          {/each}
                        </div>
                      </details>
                    {/if}
                  {/if}
                    <div class="message-role">{msg.role === 'user' ? 'You' : 'Assistant'}</div>
                    <div class="message-text">{@html renderMessageText(msg.text)}</div>
                  {#each msg.imageIds as imgId}
                    <div class="message-image">
                      {#if resolvedImageUrls[imgId]}
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <img
                          class="message-image-rendered"
                          src={resolvedImageUrls[imgId]}
                          alt={imageLabelMap.get(imgId) ?? 'Image'}
                          onclick={() => openLightbox(imgId)}
                          onkeydown={(e) => { if (e.key === 'Enter') openLightbox(imgId); }}
                        />
                      {:else}
                        <div class="image-placeholder">
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.5">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <path d="M21 15l-5-5L5 21" />
                          </svg>
                          <span>{imageLabelMap.get(imgId) ?? 'Loading...'}</span>
                        </div>
                      {/if}
                      <button
                        class="fav-btn"
                        class:favorited={favorites.has(imgId)}
                        onclick={() => toggleFavorite(imgId)}
                        title={favorites.has(imgId) ? 'Remove from favorites' : 'Add to favorites'}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={favorites.has(imgId) ? 'currentColor' : 'none'}>
                          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                      </button>
                    </div>
                  {/each}
                  {#if isLastAssistant && !turn.isRunning}
                    <div class="rollback-row">
                      <button class="rollback-btn" title="Undo this turn" onclick={handleRollback} disabled={isRollingBack}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                          <path d="M3 10h10a5 5 0 015 5v0a5 5 0 01-5 5H3" />
                          <path d="M7 6l-4 4 4 4" />
                        </svg>
                        Undo
                      </button>
                    </div>
                  {/if}
                </div>
                {/if}
              {/each}

              <!-- Optimistic user message (shown until persisted) -->
              {#if pendingUserText}
                <div class="message user" data-turn-anchor>
                  <div class="message-role">You</div>
                  <div class="message-text">{@html renderMessageText(pendingUserText)}</div>
                </div>
              {/if}

              <!-- Live assistant message (activity log + streaming text in one block) -->
              {#if turn.isRunning || turn.isSettling}
                <div class="message assistant">
                  {#if turn.activityLog.length > 0}
                    {@const lastEntry = turn.activityLog[turn.activityLog.length - 1]}
                    {#if turn.activityLog.length === 1}
                      <div class="persisted-activity">
                        <div class="activity-summary-static">
                          <span class="activity-dot"></span>
                          {lastEntry.text}
                        </div>
                      </div>
                    {:else}
                      <details
                        class="persisted-activity"
                        open={activityExpanded || undefined}
                        ontoggle={(e) => {
                          activityExpanded = e.currentTarget.open;
                        }}
                      >
                        <summary>
                          <span class="activity-dot"></span>
                          {lastEntry.text}
                          <span class="activity-chevron-icon">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </span>
                        </summary>
                        <div class="activity-log">
                          {#each turn.activityLog as entry}
                            <div class="activity-log-entry" class:nested={entry.nested}>
                              {entry.text}
                            </div>
                          {/each}
                        </div>
                      </details>
                    {/if}
                  {:else if turn.statusText}
                    <div class="persisted-activity">
                      <div class="activity-summary-static">
                        <span class="activity-dot"></span>
                        {turn.statusText}
                      </div>
                    </div>
                  {/if}
                  {#if turn.revealedText}
                    <div class="message-role">Assistant</div>
                    <div class="message-text">{@html renderMessageText(turn.revealedText)}</div>
                  {/if}
                </div>
              {/if}

              <!-- Geometry-based spacer: sizes itself so the last user message
                   can sit at the viewport top when scrolled to the bottom -->
              <div class="chat-spacer" bind:this={spacerEl}></div>
            </div>
          </div>
          <div class="fade-bottom"></div>
        </div>

        <div class="input-area">
          <div class="chat-column">
            {#if suggestedReplies.length > 0}
              <div class="suggested-replies">
                {#each suggestedReplies as reply}
                  <button class="chip" onclick={() => handleSuggestedReply(reply)}>
                    <span class="chip-arrow">&#x203a;</span> {reply}
                  </button>
                {/each}
              </div>
            {/if}
            {#if turn.errorText}
              <div class="error-row">
                <span class="error-text">{turn.errorText}</span>
                <button class="retry-btn" onclick={handleRetry}>Retry</button>
              </div>
            {/if}
            <div class="input-wrap">
              <div class="input-scroll">
                <textarea
                  class="input"
                  placeholder="What are you working on?"
                  bind:value={inputText}
                  rows="1"
                  disabled={turn.isRunning}
                  onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                ></textarea>
              </div>
              {#if turn.isRunning}
                <button
                  class="send-btn stop"
                  onclick={handleCancel}
                  title="Stop generating"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                </button>
              {:else}
                <button
                  class="send-btn"
                  disabled={!inputText.trim() && pendingFiles.length === 0}
                  onclick={handleSend}
                  title="Send message"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </button>
              {/if}
              {#if pendingFiles.length > 0}
                <div class="attachments">
                  {#each pendingFiles as att}
                    <div class="attachment">
                      <div class="attachment-thumb">
                        <img src={att.previewUrl} alt={att.file.name} />
                      </div>
                      <span class="attachment-name">{att.file.name}</span>
                      <button class="attachment-remove" onclick={() => removeAttachment(att.id)} title="Remove attachment">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>

      {:else if canvasView === 'gallery'}
        <div class="fade-container">
          <div class="fade-top"></div>
          <div class="scroll-content" use:trackScroll>
            <div class="gallery-grid">
              {#each imagesByRecency as img}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="gallery-item" onclick={() => openLightbox(img.id)}>
                  <div class="gallery-thumb">
                    {#if resolvedImageUrls[img.id]}
                      <img src={resolvedImageUrls[img.id]} alt={img.label} />
                    {:else}
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.5">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="M21 15l-5-5L5 21" />
                      </svg>
                    {/if}
                    <button
                      class="fav-btn gallery-fav"
                      class:favorited={favorites.has(img.id)}
                      onclick={(e) => { e.stopPropagation(); toggleFavorite(img.id); }}
                      title={favorites.has(img.id) ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={favorites.has(img.id) ? 'currentColor' : 'none'}>
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                    </button>
                  </div>
                  <span class="gallery-label">{img.label}</span>
                </div>
              {/each}
            </div>
          </div>
          <div class="fade-bottom"></div>
        </div>

      {:else if canvasView === 'memories'}
        <div class="fade-container">
          <div class="fade-top"></div>
          <div class="scroll-content" use:trackScroll>
            <div class="memories-canvas">
              {#each app.agentMemories as mem}
                <div class="memory-card">
                  <div class="memory-card-title">{mem.title}</div>
                  <div class="memory-card-summary">{mem.summary}</div>
                  <div class="memory-card-body">{mem.content}</div>
                </div>
              {/each}
              {#if app.agentMemories.length === 0}
                <p class="empty-state">No memories yet. The agent will create notes as you work together.</p>
              {/if}
            </div>
          </div>
          <div class="fade-bottom"></div>
        </div>
      {/if}
    </main>
  </div>
</div>

{#if lightboxImageId && resolvedImageUrls[lightboxImageId]}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox" onclick={closeLightbox} onkeydown={handleLightboxKeydown}>
    <button class="lightbox-close" onclick={closeLightbox} title="Close">&times;</button>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="lightbox-body" onclick={(e) => e.stopPropagation()}>
      <img src={resolvedImageUrls[lightboxImageId]} alt={lightboxImage?.label ?? 'Full size preview'} />
      {#if lightboxImage}
        <div class="lightbox-info">
          <div class="lightbox-title-row">
            <span class="lightbox-label">{lightboxImage.label}</span>
            <button
              class="lightbox-fav"
              class:favorited={lightboxImage.favorite}
              onclick={() => toggleFavorite(lightboxImage!.id)}
              title={lightboxImage.favorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={lightboxImage.favorite ? 'currentColor' : 'none'}>
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </button>
          </div>
          {#if lightboxImage.generationContext}
            <details class="lightbox-details">
              <summary>Prompt</summary>
              <p class="lightbox-context">{lightboxImage.generationContext}</p>
            </details>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- Debug panel: toggle with Ctrl+Shift+D -->
<svelte:window onkeydown={(e) => { if (e.ctrlKey && e.shiftKey && e.key === 'D') { debugPanelOpen = !debugPanelOpen; e.preventDefault(); }}} />

{#if debugPanelOpen}
  <div class="debug-panel">
    <div class="debug-header">
      <strong>Scroll Debug</strong>
      <button onclick={() => debugPanelOpen = false}>&times;</button>
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
          () => requestAnimationFrame(() => requestAnimationFrame(anchorToUserMessage))
        )} disabled={turn.isRunning}>
          Full turn
        </button>
        <button onclick={() => cancelTurn()} disabled={!turn.isRunning}>Cancel</button>
      </div>
    </div>

    <div class="debug-section">
      <div class="debug-label">Layout Shifts ({layoutShifts.length})</div>
      <div class="debug-buttons">
        <button onclick={debugClearShifts}>Clear</button>
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
{/if}

<style>
  :global(body) {
    margin: 0;
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: 1.5;
  }

  :global(*) {
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
    transition: scrollbar-color 0.3s;
  }

  .scroll-content:hover,
  .sidebar-scroll:hover,
  .input-scroll:hover {
    scrollbar-color: var(--color-border) transparent;
  }

  /* App layout: project bar on top, workspace below */
  .app {
    height: 100vh;
    overflow: hidden;
  }

  .workspace {
    display: flex;
    height: 100%;
  }

  /* Canvas header: floating breadcrumb / back navigation */
  .canvas-header {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4);
    z-index: 2;
    pointer-events: none;
  }

  .canvas-header > * {
    pointer-events: auto;
  }

  .back-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .back-btn:hover {
    color: var(--color-text);
  }

  .sidebar-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .sidebar-toggle:hover {
    color: var(--color-text);
  }

  .canvas-header-link {
    font-size: var(--text-base);
    color: var(--color-text-tertiary);
    text-decoration: none;
    transition: color var(--transition-fast);
  }

  .canvas-header-link:hover {
    color: var(--color-text);
  }

  .canvas-header-sep {
    font-size: var(--text-base);
    color: var(--color-text-tertiary);
  }

  .canvas-header-title {
    font-size: var(--text-base);
    color: var(--color-text-secondary);
  }

  /* Activity bar */
  .activity-bar {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-4) var(--space-3);
    background: transparent;
  }

  .activity-top {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
  }

  .activity-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .activity-btn:hover {
    color: var(--color-text);
  }

  .activity-btn.active {
    color: var(--color-text);
    background: var(--color-surface-2);
  }

  /* Sidebar */
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    width: var(--sidebar-width);
  }

  .sidebar-scroll {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--space-4) var(--space-3) var(--space-3);
  }

  /* Sidebar items */
  .sidebar-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--text-base);
    font-family: var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .sidebar-item:hover {
    color: var(--color-text);
    background: var(--color-surface-1);
  }

  .sidebar-item.active {
    color: var(--color-text);
    background: var(--color-surface-1);
  }

  .sidebar-new-chat {
    color: var(--color-accent);
  }

  .sidebar-new-chat:hover {
    color: var(--color-accent-hover);
  }

  .sidebar-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Fade container */
  .fade-container {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .fade-top,
  .fade-bottom {
    position: absolute;
    left: 0;
    right: 0;
    height: var(--space-6);
    pointer-events: none;
    z-index: 1;
    transition: opacity 400ms ease;
  }

  .fade-top {
    top: 0;
    background: linear-gradient(to bottom, var(--color-bg), transparent);
  }

  .fade-bottom {
    bottom: 0;
    background: linear-gradient(to top, var(--color-bg), transparent);
  }

  .fade-container:global(.at-top) > .fade-top {
    opacity: 0;
  }

  .fade-container:global(.at-bottom) > .fade-bottom {
    opacity: 0;
  }

  /* Canvas */
  .canvas {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    min-width: 0;
  }

  .scroll-content {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-anchor: none; /* prevent browser scroll anchoring from fighting with spacer */
    scrollbar-gutter: stable;
    padding: var(--space-8) 0;
  }

  .chat-column {
    max-width: var(--chat-max-width);
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }

  .chat-spacer {
    flex-shrink: 0;
    overflow-anchor: none;
  }

  /* scroll-margin-top on [data-turn-anchor] is set dynamically in anchorToUserMessage() */

  .message-role {
    font-size: var(--text-xs);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-tertiary);
    margin-bottom: var(--space-2);
  }

  .assistant .message-role {
    color: var(--color-agent);
  }

  .message.last-assistant {
    position: relative;
  }

  .message.last-assistant:hover {
    outline: 1px solid var(--color-border);
    outline-offset: var(--space-4);
  }

  .rollback-row {
    opacity: 0;
    transition: opacity var(--transition-fast);
    margin-top: var(--space-2);
  }

  .message.last-assistant:hover .rollback-row {
    opacity: 1;
  }

  .rollback-btn {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-bg);
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: color var(--transition-fast), border-color var(--transition-fast);
  }

  .rollback-btn:hover {
    color: var(--color-text);
    border-color: var(--color-border-hover);
  }

  .message-text {
    font-family: var(--font-serif);
    font-size: var(--text-lg);
    color: var(--color-text);
    line-height: 1.7;
  }

  .message-text :global(p) {
    margin: 0 0 0.5rem;
  }

  .message-text :global(p:last-child) {
    margin-bottom: 0;
  }

  .message-text :global(pre) {
    background: var(--color-surface-1);
    padding: 0.75rem;
    border-radius: var(--radius-md);
    overflow-x: auto;
    font-size: var(--text-sm);
  }

  .message-text :global(code) {
    background: var(--color-surface-1);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.85em;
    font-family: var(--font-mono);
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
    font-size: var(--text-base);
    font-family: var(--font-sans);
  }

  .message-text :global(blockquote) {
    border-left: 2px solid var(--color-border);
    margin: 0.5rem 0;
    padding-left: 0.75rem;
    color: var(--color-text-secondary);
  }

  :global(.image-chip) {
    display: inline;
    padding: 0.1rem 0.4rem;
    background: var(--color-accent-subtle);
    color: var(--color-accent);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  :global(.image-chip:hover) {
    background: rgba(200, 168, 78, 0.2);
  }

  .message-image {
    position: relative;
    margin-top: var(--space-4);
  }

  .message-image > .fav-btn {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
  }

  .image-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--color-surface-1);
    border-radius: var(--radius-md);
    color: var(--color-text-tertiary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
  }

  /* Favorite button */
  .fav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .fav-btn:hover {
    color: var(--color-accent);
  }

  .fav-btn.favorited {
    color: var(--color-accent);
  }


  /* Input */
  .input-area {
    padding: var(--space-2) 0 var(--space-4);
  }

  .input-area .chat-column {
    gap: var(--space-3);
  }

  .input-wrap {
    display: flex;
    flex-direction: column;
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface-1);
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    transition: border-color var(--transition-fast);
    position: relative;
  }

  .input-wrap:focus-within {
    border-color: var(--color-border-hover);
  }


  .input-scroll {
    max-height: 200px;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: var(--space-2);
  }

  .input {
    width: 100%;
    padding: var(--space-1) 0;
    padding-right: var(--space-10);
    border: none;
    background: transparent;
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: 1.5;
    resize: none;
    outline: none;
    overflow: hidden;
    field-sizing: content;
  }

  .input::placeholder {
    color: var(--color-text-tertiary);
  }

  .send-btn {
    position: absolute;
    bottom: var(--space-3);
    right: var(--space-3);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--radius-md);
    background: var(--color-accent);
    color: var(--color-bg);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--transition-fast), opacity var(--transition-fast);
  }

  .send-btn:hover {
    background: var(--color-accent-hover);
  }

  .send-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .send-btn.stop {
    background: var(--color-text-tertiary);
  }

  .send-btn.stop:hover {
    background: var(--color-text-secondary);
  }

  /* Image grid in sidebar */
  .queue-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .queue-item {
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity var(--transition-fast);
  }

  .queue-item:hover {
    opacity: 0.8;
  }

  .queue-thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-1);
  }

  .queue-fav {
    position: absolute;
    top: var(--space-1);
    right: var(--space-1);
    width: 24px;
    height: 24px;
    opacity: 0;
    transition: opacity var(--transition-fast), color var(--transition-fast);
  }

  .queue-fav.favorited {
    opacity: 1;
  }

  .queue-item:hover .queue-fav {
    opacity: 1;
  }

  .queue-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Attachments */
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: var(--space-2) 0;
  }

  .attachment {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
  }

  .attachment-thumb {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-3);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .attachment-name {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .attachment-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .attachment-remove:hover {
    color: var(--color-text);
  }

  /* Sidebar action button */
  .sidebar-action {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    text-align: left;
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--transition-fast);
  }

  .sidebar-action:hover {
    color: var(--color-accent);
  }

  /* Gallery canvas */
  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--space-4);
    padding: var(--space-4) var(--space-8);
  }

  .gallery-item {
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .gallery-item:hover {
    opacity: 0.85;
  }

  .gallery-thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-surface-1);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-2);
  }

  .gallery-fav {
    position: absolute;
    top: var(--space-1);
    right: var(--space-1);
    width: 24px;
    height: 24px;
    opacity: 0;
    transition: opacity var(--transition-fast), color var(--transition-fast);
  }

  .gallery-fav.favorited {
    opacity: 1;
  }

  .gallery-item:hover .gallery-fav {
    opacity: 1;
  }

  .gallery-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* Memories canvas */
  .memories-canvas {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-8);
    max-width: var(--chat-max-width);
    margin: 0 auto;
  }

  .memory-card {
    padding: var(--space-4);
    background: var(--color-surface-1);
    border-radius: var(--radius-md);
  }

  .memory-card-title {
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }

  .memory-card-summary {
    font-size: var(--text-sm);
    color: var(--color-text-tertiary);
    margin-bottom: var(--space-2);
  }

  .memory-card-body {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: 1.6;
    white-space: pre-wrap;
  }

  /* Rendered images in messages and thumbnails */
  .message-image-rendered {
    width: 100%;
    border-radius: var(--radius-md);
    display: block;
  }

  .queue-thumb img,
  .gallery-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: var(--radius-md);
  }

  .attachment-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: var(--radius-sm);
  }

  /* Suggested replies */
  .suggested-replies {
    display: flex;
    flex-direction: column;
    margin-bottom: var(--space-2);
  }

  .chip {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border: none;
    background: transparent;
    color: var(--color-accent);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .chip:hover {
    color: var(--color-accent-hover);
  }

  .chip-arrow {
    font-size: var(--text-lg);
    line-height: 1;
  }

  /* Persisted activity log (above assistant messages) */
  .persisted-activity {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-text-tertiary);
    margin-bottom: var(--space-2);
  }

  .persisted-activity summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
    list-style: none;
  }

  .persisted-activity summary::-webkit-details-marker {
    display: none;
  }

  .persisted-activity summary::marker {
    display: none;
    content: '';
  }

  .persisted-activity summary:hover {
    color: var(--color-text-secondary);
  }

  .activity-summary-static {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .activity-chevron-icon {
    display: flex;
    transition: transform 0.15s ease;
    transform: rotate(-90deg);
  }

  .persisted-activity[open] .activity-chevron-icon {
    transform: rotate(0deg);
  }


  .activity-log {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-top: var(--space-2);
    padding-left: var(--space-4);
  }

  .activity-log-entry {
    color: var(--color-text-tertiary);
  }

  .activity-log-entry.nested {
    padding-left: var(--space-4);
    opacity: 0.75;
  }

  .activity-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: pulse 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }

  .activity-dot.static {
    animation: none;
    opacity: 0.4;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* Error, cancel, retry */
  .error-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-1) 0;
  }

  .error-text {
    font-size: var(--text-sm);
    color: var(--color-error);
  }

  .retry-btn {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: transparent;
    font-size: var(--text-xs);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: color var(--transition-fast), border-color var(--transition-fast);
    flex-shrink: 0;
    color: var(--color-accent);
    border-color: var(--color-accent);
  }

  .retry-btn:hover {
    color: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
  }

  /* Drag-drop overlay */
  .canvas.dragging {
    outline: 2px dashed var(--color-accent);
    outline-offset: -2px;
  }

  /* Settings sidebar */
  .settings-sidebar {
    padding: var(--space-4) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .settings-label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .settings-label-text {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-tertiary);
  }

  .settings-input {
    padding: var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-1);
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    outline: none;
    transition: border-color var(--transition-fast);
  }

  .settings-input:focus {
    border-color: var(--color-border-hover);
  }

  .settings-save-btn {
    padding: var(--space-2) var(--space-4);
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-accent);
    color: var(--color-bg);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .settings-save-btn:hover {
    background: var(--color-accent-hover);
  }

  .settings-divider {
    height: 1px;
    background: var(--color-border);
  }

  .agent-first-prompt {
    display: flex;
    justify-content: center;
    padding: var(--space-8) 0;
  }

  .agent-first-btn {
    background: transparent;
    color: var(--color-text-tertiary);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-full);
    padding: var(--space-2) var(--space-6);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: color var(--transition-fast), border-color var(--transition-fast);
  }

  .agent-first-btn:hover {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }

  .empty-state {
    font-size: var(--text-base);
    color: var(--color-text-tertiary);
    text-align: center;
    padding: var(--space-8) 0;
    margin: 0;
  }

  /* Lightbox */
  .lightbox {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.92);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    cursor: pointer;
  }

  .lightbox-close {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    background: none;
    border: none;
    color: var(--color-text-tertiary);
    font-size: 2rem;
    cursor: pointer;
    line-height: 1;
    transition: color var(--transition-fast);
  }

  .lightbox-close:hover {
    color: var(--color-accent);
  }

  .lightbox-body {
    cursor: default;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .lightbox-body img {
    max-width: 90vw;
    max-height: 80vh;
    object-fit: contain;
    border-radius: var(--radius-md);
  }

  .lightbox-info {
    margin-top: var(--space-3);
    max-width: 60ch;
  }

  .lightbox-title-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
  }

  .lightbox-label {
    color: var(--color-text);
    font-size: var(--text-base);
    font-family: var(--font-sans);
  }

  .lightbox-details {
    margin-top: var(--space-2);
  }

  .lightbox-details summary {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .lightbox-details summary:hover {
    color: var(--color-text-secondary);
  }

  .lightbox-context {
    color: var(--color-text-tertiary);
    font-size: var(--text-xs);
    margin: var(--space-2) 0 0;
    line-height: 1.6;
    max-height: 30vh;
    overflow-y: auto;
  }

  .lightbox-fav {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: color var(--transition-fast);
    flex-shrink: 0;
  }

  .lightbox-fav:hover {
    color: var(--color-accent);
  }

  .lightbox-fav.favorited {
    color: var(--color-accent);
  }

  .message-image-rendered {
    cursor: pointer;
  }

  /* ── Debug panel ── */

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
