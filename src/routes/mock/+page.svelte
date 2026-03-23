<script lang="ts">
  import '$lib/styles/tokens.css';

  const projects = [
    { id: 'p1', name: 'Character Designs', active: true },
    { id: 'p2', name: 'Album Artwork', active: false },
  ];

  const conversations = [
    { id: '1', title: 'Cyberpunk alley scene', active: true },
    { id: '2', title: 'Sunset harbor painting', active: false },
    { id: '3', title: 'Abstract pattern set', active: false },
    { id: '4', title: 'Character turnaround sheet', active: false },
    { id: '5', title: 'Mech design iterations', active: false },
    { id: '6', title: 'Watercolor landscape study', active: false },
    { id: '7', title: 'Logo concepts round 2', active: false },
    { id: '8', title: 'Creature silhouettes', active: false },
    { id: '9', title: 'Interior mood boards', active: false },
    { id: '10', title: 'Poster layout drafts', active: false },
    { id: '11', title: 'Pixel art sprites', active: false },
    { id: '12', title: 'Album cover rework', active: false },
    { id: '13', title: 'Storyboard frames', active: false },
    { id: '14', title: 'Texture pack experiments', active: false },
    { id: '15', title: 'Portrait lighting study', active: false },
    { id: '16', title: 'Isometric city block', active: false },
    { id: '17', title: 'Hand lettering practice', active: false },
    { id: '18', title: 'Fantasy map draft', active: false },
    { id: '19', title: 'Botanical illustrations', active: false },
    { id: '20', title: 'Glitch art series', active: false },
    { id: '21', title: 'Vehicle concept art', active: false },
    { id: '22', title: 'Retro poster pastiche', active: false },
    { id: '23', title: 'Fabric pattern tiles', active: false },
    { id: '24', title: 'Weapon prop designs', active: false },
    { id: '25', title: 'Ink wash mountains', active: false },
    { id: '26', title: 'UI icon set', active: false },
    { id: '27', title: 'Graffiti wall comp', active: false },
    { id: '28', title: 'Architectural sketch', active: false },
    { id: '29', title: 'Tarot card series', active: false },
    { id: '30', title: 'Neon signage collection', active: false },
    { id: '31', title: 'Chibi character batch', active: false },
    { id: '32', title: 'Underwater scene', active: false },
    { id: '33', title: 'Vintage ad parody', active: false },
    { id: '34', title: 'Cloud study timelapse', active: false },
    { id: '35', title: 'Geometric animal logos', active: false },
  ];

  const messages = [
    {
      id: '1',
      role: 'user' as const,
      text: 'I want to create a cyberpunk alley scene. Neon signs, wet pavement, lots of atmosphere. Think Blade Runner but more colorful.',
    },
    {
      id: '2',
      role: 'assistant' as const,
      text: "Great concept. I'm thinking narrow alley, overhead neon signage in Japanese and English, rain-slicked asphalt reflecting pinks and teals. Want me to generate an initial composition, or should we nail down the color palette first?",
    },
    {
      id: '3',
      role: 'user' as const,
      text: "Let's go straight to a first pass. Heavy on the magenta and cyan.",
    },
    {
      id: '4',
      role: 'assistant' as const,
      text: "Here's the first composition. I pushed the magenta into the overhead signage and used cyan for the ground reflections and distant fog. The alley narrows toward a vanishing point with a lone figure for scale.",
      image: { id: 'img-1', label: 'Cyberpunk alley v1' },
    },
    {
      id: '5',
      role: 'user' as const,
      text: "Love the atmosphere. Can you make the neon signs more prominent? I want them to really pop against the dark alley walls.",
    },
    {
      id: '6',
      role: 'assistant' as const,
      text: "I've cranked up the neon intensity and added a few more sign clusters along the upper walls. The magenta and cyan now bleed more aggressively into the surrounding fog, and I added some kanji signage with a warm amber glow for contrast.",
      image: { id: 'img-2', label: 'Cyberpunk alley v2' },
    },
  ];

  let favorites = $state(new Set(['img-2']));

  function toggleFavorite(imageId: string) {
    if (favorites.has(imageId)) {
      favorites.delete(imageId);
    } else {
      favorites.add(imageId);
    }
    favorites = new Set(favorites);
  }

  const recentImages = [
    { id: 'img-2', label: 'Cyberpunk alley v2' },
    { id: 'img-1', label: 'Cyberpunk alley v1' },
    { id: 'img-3', label: 'Neon sign close-up' },
    { id: 'img-4', label: 'Alley rain detail' },
    { id: 'img-5', label: 'Wide shot variant' },
    { id: 'img-6', label: 'Color palette test' },
    { id: 'img-7', label: 'Fog and lamplight' },
    { id: 'img-8', label: 'Rooftop silhouette' },
    { id: 'img-9', label: 'Market stall glow' },
    { id: 'img-10', label: 'Fire escape geometry' },
    { id: 'img-11', label: 'Puddle reflection' },
    { id: 'img-12', label: 'Vending machines' },
    { id: 'img-13', label: 'Overhead wires' },
    { id: 'img-14', label: 'Back alley cat' },
    { id: 'img-15', label: 'Neon kanji grid' },
  ];

  let imageQueueOpen = $state(true);
  let inputText = $state('');
  let activeProject = $state(projects[0]);
  let projectDropdownOpen = $state(false);

  function selectProject(project: typeof projects[0]) {
    activeProject = project;
    projectDropdownOpen = false;
  }

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
</script>

<div class="app" class:queue-open={imageQueueOpen}>
  <!-- Left sidebar: navigation + conversations -->
  <aside class="panel panel-left">
    <div class="panel-pinned">
      <div class="project-dropdown">
        <button class="project-trigger" onclick={() => projectDropdownOpen = !projectDropdownOpen}>
          <svg class="project-trigger-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <span class="project-trigger-name">{activeProject.name}</span>
          <svg class="project-trigger-chevron" class:open={projectDropdownOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {#if projectDropdownOpen}
          <div class="project-menu">
            {#each projects as project}
              <button
                class="project-menu-item"
                class:active={project.id === activeProject.id}
                onclick={() => selectProject(project)}
              >
                {project.name}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <button class="sidebar-item sidebar-nav-link">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
        <span class="sidebar-item-name">Settings</span>
      </button>
      <button class="sidebar-item sidebar-nav-link">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span class="sidebar-item-name">New chat</span>
      </button>

      <div class="sidebar-divider"></div>

      <div class="sidebar-section-label">Recent</div>
      {#each conversations.slice(0, 5) as convo}
        <button class="sidebar-item" class:active={convo.active}>
          <span class="sidebar-item-name">{convo.title}</span>
        </button>
      {/each}

      <button class="sidebar-item sidebar-nav-link" style="margin-top: var(--space-2)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span class="sidebar-item-name">All conversations</span>
      </button>
    </div>
  </aside>

  <!-- Center: chat -->
  <main class="chat">
    <div class="fade-container">
      <div class="fade-top"></div>
      <div class="scroll-content" use:trackScroll>
        <div class="chat-column">
          {#each messages as msg}
            <div class="message" class:user={msg.role === 'user'} class:assistant={msg.role === 'assistant'}>
              <div class="message-role">{msg.role === 'user' ? 'You' : 'Assistant'}</div>
              <div class="message-text">{msg.text}</div>
              {#if msg.image}
                <div class="message-image">
                  <div class="image-placeholder">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                    <span>{msg.image.label}</span>
                  </div>
                  <button
                    class="fav-btn"
                    class:favorited={favorites.has(msg.image.id)}
                    onclick={() => toggleFavorite(msg.image!.id)}
                    title={favorites.has(msg.image.id) ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={favorites.has(msg.image.id) ? 'currentColor' : 'none'}>
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                  </button>
                </div>
              {/if}
            </div>
          {/each}

          <div class="suggested-replies">
            <button class="chip"><span class="chip-arrow">›</span> Darken the background and push the neon glow further into the fog</button>
            <button class="chip"><span class="chip-arrow">›</span> Try a low angle looking up at the signs</button>
            <button class="chip"><span class="chip-arrow">›</span> Add some street-level detail like puddles and scattered trash</button>
          </div>
        </div>
      </div>
      <div class="fade-bottom"></div>
    </div>

    <div class="input-area">
      <div class="chat-column">
        <div class="input-wrap">
          <textarea
            class="input"
            placeholder="Describe what you want to create..."
            bind:value={inputText}
            rows="1"
          ></textarea>
          <button class="send-btn" disabled={!inputText.trim()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </main>

  <!-- Right sidebar: image queue -->
  {#if imageQueueOpen}
    <aside class="panel panel-right">
      <div class="panel-pinned">
        <div class="sidebar-section-label">Recent Images</div>
        <button class="sidebar-item sidebar-nav-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
          <span class="sidebar-item-name">Full gallery</span>
        </button>
      </div>

      <div class="fade-container">
        <div class="fade-top"></div>
        <div class="queue-list" use:trackScroll>
          {#each recentImages as img}
            <div class="queue-item">
              <div class="queue-thumb">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" stroke-width="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
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
    </aside>
  {/if}
</div>

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
    scrollbar-color: var(--color-border) transparent;
  }

  /* App grid: left panel, chat, optional right panel */
  .app {
    display: grid;
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    height: 100vh;
    overflow: hidden;
  }

  .app.queue-open {
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--sidebar-width);
  }

  /* Panels — shared structure for left and right sidebars */
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .panel-pinned {
    padding: var(--space-4) var(--space-4) 0;
    flex-shrink: 0;
  }

  .panel-scrollable {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    scrollbar-width: none;
    padding: 0 var(--space-4) var(--space-4);
  }

  .panel-scrollable::-webkit-scrollbar {
    display: none;
  }


  /* Left sidebar specifics */
  .sidebar-section-label {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-tertiary);
    padding: var(--space-2);
    margin-bottom: var(--space-1);
  }

  /* Project dropdown */
  .project-dropdown {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .project-trigger {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-surface-1);
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .project-trigger:hover {
    color: var(--color-accent);
  }

  .project-trigger-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-trigger-icon {
    flex-shrink: 0;
  }

  .project-trigger-chevron {
    flex-shrink: 0;
    margin-left: auto;
    transition: transform var(--transition-fast);
  }

  .project-trigger-chevron.open {
    transform: rotate(180deg);
  }

  .project-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    padding: var(--space-1);
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    z-index: 10;
    margin-top: var(--space-1);
  }

  .project-menu-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .project-menu-item:hover {
    color: var(--color-text);
  }

  .project-menu-item.active {
    color: var(--color-accent);
  }

  .project-menu-action {
    color: var(--color-text-tertiary);
  }

  .sidebar-divider {
    height: 1px;
    background: var(--color-border);
    margin: var(--space-4) var(--space-2);
  }

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
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .sidebar-item:hover {
    color: var(--color-text);
  }

  .sidebar-item.active {
    color: var(--color-text);
  }

  .sidebar-nav-link {
    color: var(--color-text-tertiary);
  }

  .sidebar-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon-btn {
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

  .icon-btn:hover {
    color: var(--color-text);
  }

  /* Fade container — shared by chat scroll and queue scroll */
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

  /* Chat */
  .chat {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .scroll-content {
    position: absolute;
    inset: 0;
    overflow-y: auto;
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

  .message-text {
    font-family: var(--font-serif);
    font-size: var(--text-lg);
    color: var(--color-text);
    line-height: 1.7;
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
    aspect-ratio: 16 / 10;
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

  /* Suggested replies */
  .suggested-replies {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .chip {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--transition-fast), color var(--transition-fast);
  }

  .chip-arrow {
    color: var(--color-text-tertiary);
    font-size: var(--text-lg);
    line-height: 1;
    transition: color var(--transition-fast);
  }

  .chip:hover .chip-arrow {
    color: var(--color-accent);
  }

  .chip:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  /* Input */
  .input-area {
    padding: var(--space-4) 0 var(--space-6);
    overflow-y: hidden;
    scrollbar-gutter: stable;
  }

  .input-wrap {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    background: var(--color-surface-1);
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    transition: border-color var(--transition-fast);
  }

  .input-wrap:focus-within {
    border-color: var(--color-border-hover);
  }

  .input {
    flex: 1;
    padding: var(--space-1) 0;
    border: none;
    background: transparent;
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: 1.5;
    resize: none;
    outline: none;
  }

  .input::placeholder {
    color: var(--color-text-tertiary);
  }

  .send-btn {
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

  /* Right panel: image queue */
  .queue-list {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0 var(--space-4) var(--space-4);
  }

  .queue-list::-webkit-scrollbar {
    display: none;
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
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
</style>
