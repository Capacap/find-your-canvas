<script lang="ts">
  import { getAppState, toggleFavorite } from '$lib/stores/appState.svelte';

  interface Props {
    imageId: string | null;
    onclose: () => void;
  }

  let { imageId, onclose }: Props = $props();

  const app = getAppState();

  let image = $derived(app.projectImages.find(img => img.id === imageId));
  let url = $derived(imageId ? app.resolvedUrls[imageId] : undefined);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }
</script>

{#if imageId && url}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox" onclick={onclose} onkeydown={handleKeydown}>
    <button class="lightbox-close" onclick={onclose} title="Close">&times;</button>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="lightbox-body" onclick={(e) => e.stopPropagation()}>
      <img src={url} alt={image?.label ?? 'Full size preview'} />
      {#if image}
        <div class="lightbox-info">
          <div class="lightbox-title-row">
            <span class="lightbox-label">{image.label}</span>
            <button
              class="lightbox-fav"
              class:favorited={image.favorite}
              onclick={() => toggleFavorite(image!.id)}
              title={image.favorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill={image.favorite ? 'currentColor' : 'none'}>
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </button>
          </div>
          {#if image.generationContext}
            <details class="lightbox-details">
              <summary>Prompt</summary>
              <p class="lightbox-context">{image.generationContext}</p>
            </details>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
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
</style>
