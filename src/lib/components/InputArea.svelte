<script lang="ts">
  interface Props {
    disabled: boolean;
    suggestedReplies: string[];
    errorText: string;
    onsend: (text: string, files: File[]) => void;
    onretry: () => void;
    oncancel: () => void;
  }

  let { disabled, suggestedReplies, errorText, onsend, onretry, oncancel }: Props = $props();

  // File attachments
  type PendingFile = { id: string; file: File; previewUrl: string };
  let pendingFiles = $state<PendingFile[]>([]);
  const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

  let inputText = $state('');

  export function setInput(text: string) {
    inputText = text;
  }

  export function addFiles(files: FileList | File[]) {
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

  function handleSend() {
    const text = inputText.trim();
    if (!text && pendingFiles.length === 0) return;
    const files = pendingFiles.map(f => f.file);
    inputText = '';
    for (const pf of pendingFiles) URL.revokeObjectURL(pf.previewUrl);
    pendingFiles = [];
    onsend(text, files);
  }

  function handleSuggestedReply(reply: string) {
    inputText = reply;
    handleSend();
  }
</script>

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
    {#if errorText}
      <div class="error-row">
        <span class="error-text">{errorText}</span>
        <button class="retry-btn" onclick={onretry}>Retry</button>
      </div>
    {/if}
    <div class="input-wrap">
      <div class="input-scroll">
        <textarea
          class="input"
          placeholder="What are you working on?"
          bind:value={inputText}
          rows="1"
          {disabled}
          onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
        ></textarea>
      </div>
      {#if disabled}
        <button
          class="send-btn stop"
          onclick={oncancel}
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

<style>
  .input-area {
    padding: var(--space-2) 0 var(--space-4);
  }

  .input-area .chat-column {
    gap: var(--space-3);
  }

  .chat-column {
    max-width: var(--chat-max-width);
    margin: 0 auto;
    padding: 0 var(--space-4);
    display: flex;
    flex-direction: column;
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
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
    transition: scrollbar-color 0.3s;
  }

  .input-scroll:hover {
    scrollbar-color: var(--color-border) transparent;
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

  .attachment-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: var(--radius-sm);
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
</style>
