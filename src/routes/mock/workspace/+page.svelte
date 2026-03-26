<script lang="ts">
  import '$lib/styles/tokens.css';
  import { marked } from 'marked';
  import { onMount } from 'svelte';
  import { trackScroll } from '$lib/actions/trackScroll';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import InputArea from '$lib/components/InputArea.svelte';
  import DebugPanel from '$lib/components/DebugPanel.svelte';

  marked.setOptions({ breaks: true, gfm: true });
  import {
    getAppState,
    loadSettings,
    loadProjects,
    saveSettings,
    selectProject,
    selectConversation,
    createProject,
    createConversation,
    deleteAgentMemory,
    deleteConversation,
    deleteImage,
    deleteProject,
    exportProject,
    importProject,
    renameConversation,
    renameImage,
    renameProject,
    toggleFavorite,
    updateAgentMemory,
    resolveImageId,
  } from '$lib/stores/appState.svelte';
  import {
    getTurnState,
    sendMessage,
    retryMessage,
    rollbackTurn,
    cancelTurn,
    clearTurnError,
    clearDebugLog,
  } from '$lib/stores/turnState.svelte';

  const app = getAppState();
  const turn = getTurnState();

  // Local UI state
  type SidebarView = 'projects' | 'conversations' | 'images' | 'settings';
  type CanvasView = 'chat' | 'gallery' | 'memories';
  let activeView = $state<SidebarView>('conversations');
  let canvasView = $state<CanvasView>('chat');
  let sidebarExpanded = $state(true);
  let isDragging = $state(false);
  let isRollingBack = $state(false);
  let rollbackImageIds = $state<string[]>([]);
  let pendingUserText = $state<string | null>(null);
  let chatScrollEl = $state<HTMLElement | null>(null);
  let activityExpanded = $state(false);
  let apiKeyInput = $state('');

  // ── Gallery state ──
  type GallerySize = 'small' | 'medium' | 'large';
  let gallerySearch = $state('');
  let gallerySize = $state<GallerySize>('medium');
  let renamingImageId = $state<string | null>(null);
  let renamingImageLabel = $state('');
  let confirmDeleteImageId = $state<string | null>(null);
  let galleryMenuImageId = $state<string | null>(null);

  let filteredGalleryImages = $derived.by(() => {
    const images = app.imagesByRecency;
    if (!gallerySearch.trim()) return images;
    const q = gallerySearch.toLowerCase();
    return images.filter(img => {
      const label = img.label?.toLowerCase() ?? '';
      const ctx = img.generationContext?.toLowerCase() ?? '';
      return label.includes(q) || ctx.includes(q);
    });
  });

  function startRenameImage(id: string, currentLabel: string) {
    galleryMenuImageId = null;
    renamingImageId = id;
    renamingImageLabel = currentLabel;
  }

  async function commitRenameImage() {
    if (renamingImageId && renamingImageLabel.trim()) {
      await renameImage(renamingImageId, renamingImageLabel.trim());
    }
    renamingImageId = null;
  }

  function cancelRenameImage() {
    renamingImageId = null;
  }

  async function handleDeleteImage(id: string) {
    confirmDeleteImageId = null;
    galleryMenuImageId = null;
    await deleteImage(id);
  }

  // ── Memory editing state ──
  let editingMemoryId = $state<string | null>(null);
  let editingMemoryTitle = $state('');
  let editingMemoryContent = $state('');
  let confirmDeleteMemoryId = $state<string | null>(null);

  function startEditMemory(id: string, title: string, content: string) {
    editingMemoryId = id;
    editingMemoryTitle = title;
    editingMemoryContent = content;
  }

  async function commitEditMemory() {
    if (editingMemoryId) {
      await updateAgentMemory(editingMemoryId, {
        title: editingMemoryTitle.trim(),
        content: editingMemoryContent,
      });
    }
    editingMemoryId = null;
  }

  function cancelEditMemory() {
    editingMemoryId = null;
  }

  async function handleDeleteMemory(id: string) {
    confirmDeleteMemoryId = null;
    await deleteAgentMemory(id);
  }

  function clearEditingState() {
    renamingImageId = null;
    renamingImageLabel = '';
    galleryMenuImageId = null;
    confirmDeleteImageId = null;
    editingMemoryId = null;
    editingMemoryTitle = '';
    editingMemoryContent = '';
    confirmDeleteMemoryId = null;
    renamingProjectId = null;
    renamingProjectName = '';
    projectMenuId = null;
    confirmDeleteProjectId = null;
    renamingConvoId = null;
    renamingConvoTitle = '';
    convoMenuId = null;
    confirmDeleteConvoId = null;
  }

  function handleActivityClick(view: SidebarView) {
    clearEditingState();
    if (activeView === view) {
      sidebarExpanded = !sidebarExpanded;
    } else {
      activeView = view;
      sidebarExpanded = true;
    }
    // Switching to conversations returns to chat canvas
    if (view === 'conversations') canvasView = 'chat';
  }

  // ── Debug panel state ──
  let debugPanelOpen = $state(false);
  let layoutShifts = $state<Array<{ time: number; value: number; sources: string[] }>>([]);
  let scrollMetrics = $state({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, spacerHeight: 0 });
  let roFireCount = $state(0);

  // Sync API key input with store
  $effect.pre(() => {
    apiKeyInput = app.settings?.geminiApiKey ?? '';
  });

  // Drag-drop handlers (forwarded to InputArea)
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
    if (e.dataTransfer?.files) inputArea.addFiles(e.dataTransfer.files);
  }

  // Lightbox
  let lightboxImageId = $state<string | null>(null);

  function openLightbox(imageId: string) {
    lightboxImageId = imageId;
  }

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
        const label = app.imageLabelMap.get(id) ?? id.slice(0, 8);
        return `<span class="image-chip" data-image-id="${id}">${escapeHtml(label)}</span>`;
      }
    );
    return marked.parse(withImages, { async: false }) as string;
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

  // Project actions
  let renamingProjectId = $state<string | null>(null);
  let renamingProjectName = $state('');
  let confirmDeleteProjectId = $state<string | null>(null);
  let projectMenuId = $state<string | null>(null);

  async function handleSelectProject(id: string) {
    if (id === app.currentProject?.id) return;
    clearTurnError();
    clearDebugLog();
    await selectProject(id);
    if (app.conversations.length > 0) {
      await selectConversation(app.conversations[0].id);
    }
    activeView = 'conversations';
    canvasView = 'chat';
  }

  async function handleNewProject() {
    await createProject('Untitled project', false);
    await createConversation('New conversation');
    activeView = 'conversations';
    canvasView = 'chat';
  }

  function startRenameProject(id: string, currentName: string) {
    projectMenuId = null;
    renamingProjectId = id;
    renamingProjectName = currentName;
  }

  async function commitRenameProject() {
    if (renamingProjectId && renamingProjectName.trim()) {
      await renameProject(renamingProjectId, renamingProjectName.trim());
    }
    renamingProjectId = null;
  }

  function cancelRenameProject() {
    renamingProjectId = null;
  }

  async function handleExportProject(id: string) {
    projectMenuId = null;
    if (app.currentProject?.id !== id) {
      await selectProject(id);
    }
    await exportProject();
  }

  async function handleImportProject() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      await importProject(file);
      activeView = 'conversations';
      canvasView = 'chat';
    };
    input.click();
  }

  async function handleDeleteProject(id: string) {
    confirmDeleteProjectId = null;
    projectMenuId = null;
    if (app.currentProject?.id !== id) {
      await selectProject(id);
    }
    await deleteProject();
    if (app.projects.length > 0) {
      await selectProject(app.projects[0].id);
      activeView = 'conversations';
    }
  }

  // Conversation actions
  let convoMenuId = $state<string | null>(null);
  let renamingConvoId = $state<string | null>(null);
  let renamingConvoTitle = $state('');
  let confirmDeleteConvoId = $state<string | null>(null);

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

  function startRenameConvo(id: string, currentTitle: string) {
    convoMenuId = null;
    renamingConvoId = id;
    renamingConvoTitle = currentTitle;
  }

  async function commitRenameConvo() {
    if (renamingConvoId && renamingConvoTitle.trim()) {
      await renameConversation(renamingConvoId, renamingConvoTitle.trim());
    }
    renamingConvoId = null;
  }

  function cancelRenameConvo() {
    renamingConvoId = null;
  }

  async function handleDeleteConversation(id: string) {
    confirmDeleteConvoId = null;
    convoMenuId = null;
    await deleteConversation(id);
  }

  // Send message
  let inputArea: InputArea;

  async function handleSend(text: string, files: File[]) {
    if (!text && files.length === 0) return;

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

    const reattach = rollbackImageIds;
    rollbackImageIds = [];
    if (!isSystemNotice(text)) {
      pendingUserText = text;
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
        inputArea.setInput(result.userText);
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

  function autosize(node: HTMLTextAreaElement) {
    function resize() {
      node.style.height = 'auto';
      node.style.height = node.scrollHeight + 'px';
    }
    resize();
    node.addEventListener('input', resize);
    return { destroy() { node.removeEventListener('input', resize); } };
  }

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

  function debugClearShifts() {
    layoutShifts = [];
    roFireCount = 0;
  }
</script>

<div class="app">
  <div class="workspace">
      <!-- Activity bar: always visible -->
      <nav class="activity-bar">
        <div class="activity-top">
      <button
        class="activity-btn"
        class:active={activeView === 'projects' && sidebarExpanded}
        onclick={() => handleActivityClick('projects')}
        title="Projects"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
      </button>
      <button
        class="activity-btn"
        class:active={activeView === 'conversations' && sidebarExpanded}
        onclick={() => handleActivityClick('conversations')}
        title="Conversations"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
      </button>
      <button
        class="activity-btn"
        class:active={activeView === 'images' && sidebarExpanded}
        onclick={() => handleActivityClick('images')}
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
        class:active={activeView === 'settings' && sidebarExpanded}
        onclick={() => handleActivityClick('settings')}
        title="Settings"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      </button>
        </div>
      </nav>

      <!-- Sidebar panel: collapsible -->
      {#if sidebarExpanded}
      <aside class="sidebar">
        {#if activeView === 'projects'}
      <div class="fade-container">
        <div class="fade-top"></div>
        <div class="sidebar-scroll" use:trackScroll>
          <button class="sidebar-item sidebar-new-chat" onclick={handleNewProject}>
            <span class="sidebar-item-name">+ New project</span>
          </button>
          <button class="sidebar-item sidebar-new-chat" onclick={handleImportProject}>
            <span class="sidebar-item-name">+ Import project</span>
          </button>
          {#each app.projects as project}
            <div class="sidebar-project-item" class:active={project.id === app.currentProject?.id}>
              {#if renamingProjectId === project.id}
                <input
                  class="sidebar-rename-input"
                  type="text"
                  bind:value={renamingProjectName}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitRenameProject();
                    if (e.key === 'Escape') cancelRenameProject();
                  }}
                  onblur={commitRenameProject}
                  autofocus
                />
              {:else}
                <button
                  class="sidebar-item"
                  class:active={project.id === app.currentProject?.id}
                  onclick={() => handleSelectProject(project.id)}
                  ondblclick={() => startRenameProject(project.id, project.name)}
                >
                  <span class="sidebar-item-name">{project.name}</span>
                </button>
                <div class="sidebar-menu-anchor">
                  <button
                    class="sidebar-action-btn"
                    onclick={() => projectMenuId = projectMenuId === project.id ? null : project.id}
                    title="Project actions"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>
                  {#if projectMenuId === project.id}
                    <div class="project-context-menu">
                      <button class="context-menu-item" onclick={() => startRenameProject(project.id, project.name)}>
                        Rename
                      </button>
                      <button class="context-menu-item" onclick={() => handleExportProject(project.id)}>
                        Export
                      </button>
                      {#if confirmDeleteProjectId === project.id}
                        <div class="context-menu-confirm">
                          <span class="confirm-text">Delete?</span>
                          <button class="confirm-yes" onclick={() => handleDeleteProject(project.id)}>Yes</button>
                          <button class="confirm-no" onclick={() => { confirmDeleteProjectId = null; projectMenuId = null; }}>No</button>
                        </div>
                      {:else}
                        <button class="context-menu-item context-menu-danger" onclick={() => confirmDeleteProjectId = project.id}>
                          Delete
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
        <div class="fade-bottom"></div>
      </div>

    {:else if activeView === 'conversations'}
      <div class="fade-container">
        <div class="fade-top"></div>
        <div class="sidebar-scroll" use:trackScroll>
          <button class="sidebar-item sidebar-new-chat" onclick={handleNewChat}>
            <span class="sidebar-item-name">+ New chat</span>
          </button>
          {#each app.conversations as convo}
            <div class="sidebar-project-item" class:active={convo.id === app.currentConversation?.id}>
              {#if renamingConvoId === convo.id}
                <input
                  class="sidebar-rename-input"
                  type="text"
                  bind:value={renamingConvoTitle}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitRenameConvo();
                    if (e.key === 'Escape') cancelRenameConvo();
                  }}
                  onblur={commitRenameConvo}
                  autofocus
                />
              {:else}
                <button
                  class="sidebar-item"
                  class:active={convo.id === app.currentConversation?.id}
                  onclick={() => handleSelectConversation(convo.id)}
                  ondblclick={() => startRenameConvo(convo.id, convo.title)}
                >
                  <span class="sidebar-item-name">{convo.title}</span>
                </button>
                <div class="sidebar-menu-anchor">
                  <button
                    class="sidebar-action-btn"
                    onclick={() => convoMenuId = convoMenuId === convo.id ? null : convo.id}
                    title="Conversation actions"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>
                  {#if convoMenuId === convo.id}
                    <div class="project-context-menu">
                      <button class="context-menu-item" onclick={() => startRenameConvo(convo.id, convo.title)}>
                        Rename
                      </button>
                      {#if confirmDeleteConvoId === convo.id}
                        <div class="context-menu-confirm">
                          <span class="confirm-text">Delete?</span>
                          <button class="confirm-yes" onclick={() => handleDeleteConversation(convo.id)}>Yes</button>
                          <button class="confirm-no" onclick={() => { confirmDeleteConvoId = null; convoMenuId = null; }}>No</button>
                        </div>
                      {:else}
                        <button class="context-menu-item context-menu-danger" onclick={() => confirmDeleteConvoId = convo.id}>
                          Delete
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
        <div class="fade-bottom"></div>
      </div>

    {:else if activeView === 'images'}
      <div class="fade-container">
        <div class="fade-top"></div>
        <div class="sidebar-scroll queue-grid" use:trackScroll>
          <button class="sidebar-item sidebar-new-chat" onclick={() => canvasView = 'gallery'}>
            <span class="sidebar-item-name">&rsaquo; Open gallery</span>
          </button>
          {#each app.imagesByRecency as img}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="queue-item" onclick={() => openLightbox(img.id)}>
              <div class="queue-thumb">
                {#if app.resolvedUrls[img.id]}
                  <img src={app.resolvedUrls[img.id]} alt={img.label} />
                {:else}
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                {/if}
                <button
                  class="fav-btn queue-fav"
                  class:favorited={app.favorites.has(img.id)}
                  onclick={(e) => { e.stopPropagation(); toggleFavorite(img.id); }}
                  title={app.favorites.has(img.id) ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={app.favorites.has(img.id) ? 'currentColor' : 'none'}>
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

    {:else if activeView === 'settings'}
      <div class="settings-sidebar">
        <button class="sidebar-item sidebar-new-chat" onclick={() => canvasView = 'memories'}>
          <span class="sidebar-item-name">&rsaquo; Project memories</span>
        </button>
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
                      {#if app.resolvedUrls[imgId]}
                        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                        <img
                          class="message-image-rendered"
                          src={app.resolvedUrls[imgId]}
                          alt={app.imageLabelMap.get(imgId) ?? 'Image'}
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
                          <span>{app.imageLabelMap.get(imgId) ?? 'Loading...'}</span>
                        </div>
                      {/if}
                      <button
                        class="fav-btn"
                        class:favorited={app.favorites.has(imgId)}
                        onclick={() => toggleFavorite(imgId)}
                        title={app.favorites.has(imgId) ? 'Remove from favorites' : 'Add to favorites'}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={app.favorites.has(imgId) ? 'currentColor' : 'none'}>
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

        <InputArea
          bind:this={inputArea}
          disabled={turn.isRunning}
          {suggestedReplies}
          errorText={turn.errorText}
          onsend={handleSend}
          onretry={handleRetry}
          oncancel={handleCancel}
        />

      {:else if canvasView === 'gallery'}
        <div class="gallery-toolbar">
          <div class="gallery-search-wrap">
            <svg class="gallery-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              class="gallery-search-input"
              type="text"
              placeholder="Search images..."
              bind:value={gallerySearch}
            />
          </div>
          <div class="gallery-size-selector">
            <button
              class="gallery-size-btn"
              class:active={gallerySize === 'small'}
              onclick={() => gallerySize = 'small'}
              title="Small thumbnails"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <rect x="0" y="0" width="3" height="3" rx="0.5" />
                <rect x="4.33" y="0" width="3" height="3" rx="0.5" />
                <rect x="8.66" y="0" width="3" height="3" rx="0.5" />
                <rect x="13" y="0" width="3" height="3" rx="0.5" />
                <rect x="0" y="4.33" width="3" height="3" rx="0.5" />
                <rect x="4.33" y="4.33" width="3" height="3" rx="0.5" />
                <rect x="8.66" y="4.33" width="3" height="3" rx="0.5" />
                <rect x="13" y="4.33" width="3" height="3" rx="0.5" />
                <rect x="0" y="8.66" width="3" height="3" rx="0.5" />
                <rect x="4.33" y="8.66" width="3" height="3" rx="0.5" />
                <rect x="8.66" y="8.66" width="3" height="3" rx="0.5" />
                <rect x="13" y="8.66" width="3" height="3" rx="0.5" />
              </svg>
            </button>
            <button
              class="gallery-size-btn"
              class:active={gallerySize === 'medium'}
              onclick={() => gallerySize = 'medium'}
              title="Medium thumbnails"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <rect x="0" y="0" width="4.5" height="4.5" rx="0.5" />
                <rect x="5.75" y="0" width="4.5" height="4.5" rx="0.5" />
                <rect x="11.5" y="0" width="4.5" height="4.5" rx="0.5" />
                <rect x="0" y="5.75" width="4.5" height="4.5" rx="0.5" />
                <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.5" />
                <rect x="11.5" y="5.75" width="4.5" height="4.5" rx="0.5" />
                <rect x="0" y="11.5" width="4.5" height="4.5" rx="0.5" />
                <rect x="5.75" y="11.5" width="4.5" height="4.5" rx="0.5" />
                <rect x="11.5" y="11.5" width="4.5" height="4.5" rx="0.5" />
              </svg>
            </button>
            <button
              class="gallery-size-btn"
              class:active={gallerySize === 'large'}
              onclick={() => gallerySize = 'large'}
              title="Large thumbnails"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <rect x="0" y="0" width="7" height="7" rx="0.5" />
                <rect x="9" y="0" width="7" height="7" rx="0.5" />
                <rect x="0" y="9" width="7" height="7" rx="0.5" />
                <rect x="9" y="9" width="7" height="7" rx="0.5" />
              </svg>
            </button>
          </div>
        </div>
        <div class="fade-container">
          <div class="fade-top"></div>
          <div class="scroll-content" use:trackScroll>
            {#if filteredGalleryImages.length === 0}
              <p class="empty-state">
                {#if gallerySearch.trim()}
                  No images match "{gallerySearch}".
                {:else}
                  No images yet.
                {/if}
              </p>
            {:else}
              <div
                class="gallery-grid"
                class:gallery-small={gallerySize === 'small'}
                class:gallery-large={gallerySize === 'large'}
              >
                {#each filteredGalleryImages as img}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div class="gallery-item" onclick={() => openLightbox(img.id)}>
                    <div class="gallery-thumb">
                      {#if app.resolvedUrls[img.id]}
                        <img src={app.resolvedUrls[img.id]} alt={img.label} />
                      {:else}
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <path d="M21 15l-5-5L5 21" />
                        </svg>
                      {/if}
                      <div class="gallery-item-actions">
                        <button
                          class="gallery-action-btn"
                          class:favorited={app.favorites.has(img.id)}
                          onclick={(e) => { e.stopPropagation(); toggleFavorite(img.id); }}
                          title={app.favorites.has(img.id) ? 'Remove from favorites' : 'Add to favorites'}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={app.favorites.has(img.id) ? 'currentColor' : 'none'}>
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                        </button>
                        <div class="gallery-menu-anchor">
                          <button
                            class="gallery-action-btn"
                            onclick={(e) => { e.stopPropagation(); galleryMenuImageId = galleryMenuImageId === img.id ? null : img.id; }}
                            title="Image actions"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                              <circle cx="12" cy="5" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="12" cy="19" r="2" />
                            </svg>
                          </button>
                          {#if galleryMenuImageId === img.id}
                            <div class="gallery-context-menu">
                              <button class="context-menu-item" onclick={(e) => { e.stopPropagation(); startRenameImage(img.id, img.label); }}>
                                Rename
                              </button>
                              {#if confirmDeleteImageId === img.id}
                                <div class="context-menu-confirm">
                                  <span class="confirm-text">Delete?</span>
                                  <button class="confirm-yes" onclick={(e) => { e.stopPropagation(); handleDeleteImage(img.id); }}>Yes</button>
                                  <button class="confirm-no" onclick={(e) => { e.stopPropagation(); confirmDeleteImageId = null; galleryMenuImageId = null; }}>No</button>
                                </div>
                              {:else}
                                <button class="context-menu-item context-menu-danger" onclick={(e) => { e.stopPropagation(); confirmDeleteImageId = img.id; }}>
                                  Delete
                                </button>
                              {/if}
                            </div>
                          {/if}
                        </div>
                      </div>
                    </div>
                    {#if renamingImageId === img.id}
                      <!-- svelte-ignore a11y_autofocus -->
                      <input
                        class="gallery-rename-input"
                        type="text"
                        bind:value={renamingImageLabel}
                        onclick={(e) => e.stopPropagation()}
                        onkeydown={(e) => {
                          if (e.key === 'Enter') commitRenameImage();
                          if (e.key === 'Escape') cancelRenameImage();
                        }}
                        onblur={commitRenameImage}
                        autofocus
                      />
                    {:else}
                      <span class="gallery-label">{img.label}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          <div class="fade-bottom"></div>
        </div>

      {:else if canvasView === 'memories'}
        <div class="fade-container">
          <div class="fade-top"></div>
          <div class="scroll-content" use:trackScroll>
            <div class="memories-canvas">
              {#if app.agentMemories.length === 0}
                <p class="empty-state">No memories yet. The agent will create notes as you work together.</p>
              {:else}
                {#each app.agentMemories as mem}
                  <div class="memory-entry">
                    {#if editingMemoryId === mem.id}
                      <div class="memory-edit">
                        <!-- svelte-ignore a11y_autofocus -->
                        <input
                          class="memory-edit-title"
                          type="text"
                          bind:value={editingMemoryTitle}
                          onkeydown={(e) => { if (e.key === 'Escape') cancelEditMemory(); }}
                          autofocus
                        />
                        <textarea
                          class="memory-edit-content"
                          bind:value={editingMemoryContent}
                          onkeydown={(e) => { if (e.key === 'Escape') cancelEditMemory(); }}
                          use:autosize
                        ></textarea>
                        <div class="memory-edit-actions">
                          <button class="memory-save-btn" onclick={commitEditMemory}>Save</button>
                          <button class="memory-cancel-btn" onclick={cancelEditMemory}>Cancel</button>
                        </div>
                      </div>
                    {:else}
                      <div class="memory-header">
                        <div class="memory-title">{mem.title}</div>
                        <div class="memory-actions">
                          <button
                            class="memory-action-btn"
                            onclick={() => startEditMemory(mem.id, mem.title, mem.content)}
                            title="Edit memory"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          {#if confirmDeleteMemoryId === mem.id}
                            <span class="confirm-text">Delete?</span>
                            <button class="confirm-yes" onclick={() => handleDeleteMemory(mem.id)}>Yes</button>
                            <button class="confirm-no" onclick={() => confirmDeleteMemoryId = null}>No</button>
                          {:else}
                            <button
                              class="memory-action-btn memory-delete-btn"
                              onclick={() => confirmDeleteMemoryId = mem.id}
                              title="Delete memory"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                              </svg>
                            </button>
                          {/if}
                        </div>
                      </div>
                      <div class="memory-body">{@html marked.parse(mem.content, { async: false })}</div>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </div>
          <div class="fade-bottom"></div>
        </div>
      {/if}
    </main>
  </div>
</div>

<Lightbox imageId={lightboxImageId} onclose={() => lightboxImageId = null} />

<!-- Debug panel: toggle with Ctrl+Shift+D -->
<svelte:window
  onkeydown={(e) => { if (e.ctrlKey && e.shiftKey && e.key === 'D') { debugPanelOpen = !debugPanelOpen; e.preventDefault(); }}}
  onclick={(e) => {
    const target = e.target as HTMLElement;
    if ((projectMenuId || convoMenuId) && !target.closest('.sidebar-menu-anchor')) {
      projectMenuId = null;
      convoMenuId = null;
      confirmDeleteProjectId = null;
      confirmDeleteConvoId = null;
    }
    if (galleryMenuImageId && !target.closest('.gallery-menu-anchor')) {
      galleryMenuImageId = null;
      confirmDeleteImageId = null;
    }
    if (confirmDeleteMemoryId && !target.closest('.memory-actions')) {
      confirmDeleteMemoryId = null;
    }
  }}
/>

{#if debugPanelOpen}
  <DebugPanel
    {scrollMetrics}
    {layoutShifts}
    {roFireCount}
    onclearshifts={debugClearShifts}
    onanchor={() => requestAnimationFrame(() => requestAnimationFrame(anchorToUserMessage))}
    onclose={() => debugPanelOpen = false}
  />
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
  .sidebar-scroll:hover {
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

  /* Project sidebar items */
  .sidebar-project-item {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .sidebar-project-item > .sidebar-item {
    flex: 1;
    min-width: 0;
  }

  .sidebar-menu-anchor {
    position: relative;
    flex-shrink: 0;
  }

  .sidebar-action-btn {
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
    opacity: 0;
    transition: color var(--transition-fast), opacity var(--transition-fast);
  }

  .sidebar-project-item:hover .sidebar-action-btn,
  .sidebar-action-btn:global(.menu-open) {
    opacity: 1;
  }

  .sidebar-action-btn:hover {
    color: var(--color-text);
  }

  .project-context-menu {
    position: absolute;
    top: 100%;
    right: 0;
    min-width: 120px;
    padding: var(--space-1);
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    z-index: 20;
    margin-top: var(--space-1);
  }

  .context-menu-item {
    display: block;
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .context-menu-item:hover {
    color: var(--color-text);
    background: var(--color-surface-1);
  }

  .context-menu-danger {
    color: var(--color-error);
  }

  .context-menu-danger:hover {
    color: var(--color-error-hover);
    background: var(--color-surface-1);
  }

  .context-menu-confirm {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
  }

  .confirm-text {
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }

  .confirm-yes,
  .confirm-no {
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    font-size: var(--text-xs);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .confirm-yes {
    color: var(--color-error);
  }

  .confirm-yes:hover {
    color: var(--color-error-hover);
  }

  .confirm-no {
    color: var(--color-text-tertiary);
  }

  .confirm-no:hover {
    color: var(--color-text);
  }

  .sidebar-rename-input {
    flex: 1;
    min-width: 0;
    padding: var(--space-2);
    border: 1px solid var(--color-border-hover);
    border-radius: var(--radius-sm);
    background: var(--color-surface-1);
    color: var(--color-text);
    font-size: var(--text-base);
    font-family: var(--font-sans);
    outline: none;
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
    background: var(--color-accent-subtle-hover);
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


  /* Gallery toolbar */
  .gallery-toolbar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) var(--space-3);
    flex-shrink: 0;
  }

  .gallery-search-wrap {
    position: relative;
    flex: 1;
    max-width: 320px;
  }

  .gallery-search-icon {
    position: absolute;
    left: var(--space-2);
    top: 50%;
    transform: translateY(-50%);
    color: var(--color-text-tertiary);
    pointer-events: none;
  }

  .gallery-search-input {
    width: 100%;
    padding: var(--space-2) var(--space-3) var(--space-2) calc(var(--space-2) + 20px);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: var(--color-surface-1);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    outline: none;
    transition: border-color var(--transition-fast);
  }

  .gallery-search-input:focus {
    border-color: var(--color-border-hover);
  }

  .gallery-search-input::placeholder {
    color: var(--color-text-tertiary);
  }

  .gallery-size-selector {
    display: flex;
    gap: 2px;
  }

  .gallery-size-btn {
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
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .gallery-size-btn:hover {
    color: var(--color-text-secondary);
  }

  .gallery-size-btn.active {
    color: var(--color-text);
    background: var(--color-surface-1);
  }

  /* Gallery canvas */
  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--space-4);
    padding: var(--space-4) var(--space-8);
  }

  .gallery-grid.gallery-small {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--space-3);
  }

  .gallery-grid.gallery-large {
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-6);
  }

  .gallery-item {
    cursor: pointer;
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
    overflow: hidden;
  }

  .gallery-item-actions {
    position: absolute;
    top: var(--space-1);
    right: var(--space-1);
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--transition-fast);
  }

  .gallery-item:hover .gallery-item-actions,
  .gallery-item-actions:has(.favorited) {
    opacity: 1;
  }

  .gallery-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-overlay);
    color: var(--color-text-tertiary);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .gallery-action-btn:hover {
    color: var(--color-text);
  }

  .gallery-action-btn.favorited {
    color: var(--color-accent);
  }

  .gallery-menu-anchor {
    position: relative;
  }

  .gallery-context-menu {
    position: absolute;
    top: 100%;
    right: 0;
    min-width: 120px;
    padding: var(--space-1);
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    z-index: 20;
    margin-top: var(--space-1);
  }

  .gallery-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gallery-rename-input {
    width: 100%;
    padding: var(--space-1);
    border: 1px solid var(--color-border-hover);
    border-radius: var(--radius-sm);
    background: var(--color-surface-1);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    outline: none;
  }

  /* Memories canvas */
  .memories-canvas {
    display: flex;
    flex-direction: column;
    padding: var(--space-4) var(--space-8);
    max-width: var(--chat-max-width);
    margin: 0 auto;
  }

  .memory-entry {
    padding: var(--space-4) 0;
    border-bottom: 1px solid var(--color-surface-1);
  }

  .memory-entry:last-child {
    border-bottom: none;
  }

  .memory-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .memory-title {
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--color-text);
    flex: 1;
    min-width: 0;
  }

  .memory-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    opacity: 0;
    transition: opacity var(--transition-fast);
  }

  .memory-entry:hover .memory-actions {
    opacity: 1;
  }

  .memory-action-btn {
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

  .memory-action-btn:hover {
    color: var(--color-text);
  }

  .memory-delete-btn:hover {
    color: var(--color-error);
  }

  .memory-body {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: 1.6;
  }

  .memory-body :global(p) {
    margin: 0 0 var(--space-2);
  }

  .memory-body :global(p:last-child) {
    margin-bottom: 0;
  }

  .memory-body :global(h1),
  .memory-body :global(h2),
  .memory-body :global(h3) {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    margin: var(--space-3) 0 var(--space-1);
  }

  .memory-body :global(h1:first-child),
  .memory-body :global(h2:first-child),
  .memory-body :global(h3:first-child) {
    margin-top: 0;
  }

  .memory-body :global(ul),
  .memory-body :global(ol) {
    margin: 0 0 var(--space-2);
    padding-left: var(--space-4);
  }

  .memory-body :global(strong) {
    color: var(--color-text);
    font-weight: 600;
  }

  .memory-edit {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .memory-edit-title {
    padding: var(--space-2);
    border: 1px solid var(--color-border-hover);
    border-radius: var(--radius-sm);
    background: var(--color-surface-1);
    color: var(--color-text);
    font-size: var(--text-base);
    font-weight: 500;
    font-family: var(--font-sans);
    outline: none;
  }

  .memory-edit-content {
    padding: var(--space-2);
    border: 1px solid var(--color-border-hover);
    border-radius: var(--radius-sm);
    background: var(--color-surface-1);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    line-height: 1.6;
    outline: none;
    resize: none;
    overflow: hidden;
  }

  .memory-edit-actions {
    display: flex;
    gap: var(--space-2);
  }

  .memory-save-btn {
    padding: var(--space-2) var(--space-4);
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-accent);
    color: var(--color-bg);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .memory-save-btn:hover {
    background: var(--color-accent-hover);
  }

  .memory-cancel-btn {
    padding: var(--space-2) var(--space-4);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-tertiary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .memory-cancel-btn:hover {
    color: var(--color-text);
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

  .message-image-rendered {
    cursor: pointer;
  }

  /* ── Debug panel ── */

</style>
