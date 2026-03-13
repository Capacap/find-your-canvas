<script lang="ts">
	import { onMount } from 'svelte';
	import {
		getAppState,
		loadSettings,
		saveSettings,
		loadProjects,
		selectProject,
		deselectProject,
		createNewProject,
		selectConversation,
		createNewConversation,
		deleteCurrentProject,
		removeConversation,
		renameConversation,
		refreshMessages,
		refreshProjectImages,
		refreshAgentMemories,
		getImageUrl,
		revokeImageUrls,
		exportCurrentProject,
		importProjectZip,
		removeImage
	} from '$lib/stores/appState.svelte';
	import { runAgentTurn, type OrchestratorEvent, type UserAttachment, type TurnContext, type TurnActions } from '$lib/engine/orchestrator';
	import { TEXT_MODEL, IMAGE_MODEL } from '$lib/types/schema';
	import * as ops from '$lib/db/operations';
	import { marked } from 'marked';

	// Configure marked for safe inline rendering.
	marked.setOptions({ breaks: true, gfm: true });

	const app = getAppState();

	let userInput = $state('');
	let statusText = $state('');
	let errorText = $state('');
	let isRunning = $state(false);
	let showSettings = $state(false);
	let apiKeyInput = $state('');
	let newProjectName = $state('');
	let streamedEvents = $state<OrchestratorEvent[]>([]);
	let streamingText = $state('');
	let streamingThought = $state('');
	let showMemoryPanel = $state(false);
	let showImageGallery = $state(false);
	let showDebug = $state(false);
	let lightboxImageId = $state<string | null>(null);
	let pendingFiles = $state<File[]>([]);
	let isDragging = $state(false);

	// Image URL resolution for display
	let resolvedImageUrls = $state<Record<string, string>>({});

	onMount(async () => {
		await loadSettings();
		await loadProjects();
		apiKeyInput = app.settings?.geminiApiKey ?? '';
	});

	// Resolve image URLs whenever messages change (including on reload/navigation).
	$effect(() => {
		const msgs = app.messages;
		const imageRefPattern = /\[image:([^\]]+)\]/g;
		for (const msg of msgs) {
			for (const imgId of msg.imageIds) {
				resolveImageId(imgId);
			}
			let match;
			while ((match = imageRefPattern.exec(msg.text)) !== null) {
				resolveImageId(match[1]);
			}
		}
	});

	// Resolve image URLs for project images when they change.
	$effect(() => {
		for (const img of app.projectImages) {
			resolveImageId(img.id);
		}
	});

	async function handleSaveSettings() {
		await saveSettings({ geminiApiKey: apiKeyInput });
		showSettings = false;
	}

	async function handleCreateProject() {
		if (!newProjectName.trim()) return;
		await createNewProject(newProjectName.trim());
		newProjectName = '';
	}

	async function handleSelectProject(id: string) {
		revokeImageUrls();
		await selectProject(id);
	}

	async function handleNewConversation(title = 'New conversation') {
		await createNewConversation(title);
	}

	async function resolveImageId(imageId: string) {
		if (resolvedImageUrls[imageId]) return;
		const url = await getImageUrl(imageId);
		if (url) {
			resolvedImageUrls = { ...resolvedImageUrls, [imageId]: url };
		}
	}

	async function handleSend() {
		if ((!userInput.trim() && pendingFiles.length === 0) || isRunning) return;
		if (!app.currentProject) return;

		const text = userInput.trim();
		const filesToSend = [...pendingFiles];
		pendingFiles = [];
		for (const url of pendingFileUrls.values()) URL.revokeObjectURL(url);
		pendingFileUrls = new Map();

		// Auto-create a conversation if none selected, titled from the first message.
		if (!app.currentConversation) {
			const title = text.length > 50 ? text.slice(0, 50) + '...' : text;
			await handleNewConversation(title);
		} else if (app.messages.length === 0 && app.currentConversation.title === 'New conversation') {
			// Rename a freshly created conversation that hasn't had a message yet.
			const title = text.length > 50 ? text.slice(0, 50) + '...' : text;
			await renameConversation(app.currentConversation.id, title);
		}
		userInput = '';
		isRunning = true;
		streamedEvents = [];
		streamingText = '';
		streamingThought = '';
		statusText = 'Thinking...';
		errorText = '';

		const projectId = app.currentProject.id;
		const conversationId = app.currentConversation!.id;

		const ctx: TurnContext = {
			apiKey: app.settings?.geminiApiKey ?? '',
			textModel: TEXT_MODEL,
			imageModel: IMAGE_MODEL,
			projectName: app.currentProject.name,
			agentMemories: app.agentMemories,
			projectImages: app.projectImages,
			messages: app.messages
		};

		const actions: TurnActions = {
			storeImage: (blob, label, opts) => ops.storeImage(projectId, blob, label, opts),
			getImage: ops.getImage,
			getImageThumbnail: ops.getImageThumbnailBase64,
			getAgentMemoryBySlug: (slug) => ops.getAgentMemoryBySlug(projectId, slug),
			listAgentMemories: () => ops.listAgentMemories(projectId),
			upsertAgentMemory: (slug, title, summary, content) =>
				ops.upsertAgentMemory(projectId, slug, title, summary, content)
		};

		const onEvent = (event: OrchestratorEvent) => {
			streamedEvents = [...streamedEvents, event];

			if (event.type === 'text_delta') {
				streamingText += event.text;
				statusText = '';
			} else if (event.type === 'thought_delta') {
				streamingThought += event.text;
			} else if (event.type === 'status') statusText = event.text;
			else if (event.type === 'image_generating') statusText = `Generating: ${event.label}...`;
			else if (event.type === 'image_complete') {
				resolveImageId(event.imageId);
				statusText = `Generated: ${event.label}`;
			}
			else if (event.type === 'image_viewing') statusText = `Viewing image...`;
			else if (event.type === 'memory_updated') {
				refreshAgentMemories();
				statusText = `Memory updated: ${event.slug}`;
			}
			else if (event.type === 'error') errorText = event.message;
			else if (event.type === 'done') {
				statusText = '';
			}
		};

		const attachments: UserAttachment[] = filesToSend.map((f) => ({
			blob: f,
			label: f.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ')
		}));

		try {
			const result = await runAgentTurn(ctx, actions, text, onEvent, attachments);

			// Persist messages from the turn result.
			await ops.addMessage(projectId, conversationId, 'user', result.userText, result.userImageIds);
			if (result.assistantText) {
				await ops.addMessage(projectId, conversationId, 'assistant', result.assistantText, result.assistantImageIds);
			}

			await refreshMessages();
			await refreshProjectImages();
			streamingText = '';
			streamingThought = '';

			// Resolve any image references in the new messages.
			for (const msg of app.messages) {
				for (const imgId of msg.imageIds) {
					await resolveImageId(imgId);
				}
			}
		} catch (err) {
			errorText = `Error: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			isRunning = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	/** Render message text as markdown, then resolve [image:id] references. */
	function renderMessageText(text: string): string {
		// First replace image refs with placeholders that won't be escaped by marked.
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

	async function handleDeleteProject() {
		if (!app.currentProject) return;
		if (!confirm(`Delete project "${app.currentProject.name}" and all its data?`)) return;
		await deleteCurrentProject();
	}

	async function handleDeleteConversation(id: string, title: string) {
		if (!confirm(`Delete conversation "${title}"?`)) return;
		await removeConversation(id);
	}

	const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

	function addFiles(files: FileList | File[]) {
		const images = Array.from(files).filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type));
		if (images.length > 0) {
			pendingFiles = [...pendingFiles, ...images];
		}
	}

	// Cache object URLs for pending files to avoid leaking on re-render.
	let pendingFileUrls = $state<Map<File, string>>(new Map());

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

	let attachInput = $state<HTMLInputElement>(null!);

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
		if (e.dataTransfer?.files) {
			addFiles(e.dataTransfer.files);
		}
	}

	async function handleDeleteImage(imageId: string, label: string) {
		if (!confirm(`Delete "${label}"? References in messages will show as missing.`)) return;
		await removeImage(imageId);
	}

	async function handleExportProject() {
		if (!app.currentProject) return;
		statusText = 'Exporting project...';
		try {
			await exportCurrentProject();
			statusText = '';
		} catch (err) {
			statusText = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	let importFileInput = $state<HTMLInputElement>(null!);

	async function handleImportFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		statusText = 'Importing project...';
		try {
			await importProjectZip(file);
			statusText = '';
		} catch (err) {
			statusText = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		input.value = '';
	}
</script>

<div class="app">
	<header>
		<h1>Banana Orchestra</h1>
		<nav>
			{#if app.currentProject}
				<button onclick={() => deselectProject()}>
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
					onchange={handleImportFile}
					style="display: none;"
				/>
			</div>
			{#if statusText}
				<p class="status">{statusText}</p>
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
				<button class="new-convo" onclick={() => handleNewConversation()}>+ New Conversation</button>
				{#each app.conversations as convo}
					<div class="convo-row" class:active={app.currentConversation?.id === convo.id}>
						<button
							class="convo-item"
							class:active={app.currentConversation?.id === convo.id}
							onclick={() => selectConversation(convo.id)}
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
						<div class="message {msg.role}" onclick={handleMessageClick}>
							<div class="message-role">{msg.role === 'user' ? 'You' : 'Assistant'}</div>
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

					{#if streamingThought}
						<div class="message assistant">
							<div class="message-role">Thinking</div>
							<div class="message-text thought-text">{streamingThought}</div>
						</div>
					{/if}

					{#if streamingText}
						<div class="message assistant">
							<div class="message-role">Assistant</div>
							<div class="message-text">{@html renderMessageText(streamingText)}</div>
						</div>
					{/if}

					{#if statusText}
						<div class="status">{statusText}</div>
					{/if}

					{#if errorText}
						<div class="status error">{errorText}</div>
					{/if}

					{#if showDebug && streamedEvents.some((e) => e.type.startsWith('debug_'))}
						<details class="debug-log" open>
							<summary>Debug Log</summary>
							{#each streamedEvents as event}
								{#if event.type === 'debug_system_prompt'}
									<div class="debug-entry debug-system">
										<div class="debug-label">System Prompt</div>
										<pre>{event.prompt}</pre>
									</div>
								{:else if event.type === 'debug_request'}
									<div class="debug-entry debug-request">
										<div class="debug-label">Request (round {event.round})</div>
										<div class="debug-meta">History: {event.historyLength} messages</div>
										<pre>{JSON.stringify(event.parts, null, 2)}</pre>
									</div>
								{:else if event.type === 'debug_response'}
									<div class="debug-entry debug-response">
										<div class="debug-label">Response (round {event.round})</div>
										{#if event.text}
											<pre class="debug-text">{event.text}</pre>
										{/if}
										{#if event.functionCalls.length > 0}
											<div class="debug-label">Function Calls</div>
											<pre>{JSON.stringify(event.functionCalls, null, 2)}</pre>
										{/if}
									</div>
								{:else if event.type === 'debug_tool_exec'}
									<div class="debug-entry debug-tool">
										<div class="debug-label">Tool Call: {event.name}</div>
										<pre>{JSON.stringify(event.args, null, 2)}</pre>
									</div>
								{:else if event.type === 'debug_tool_result'}
									<div class="debug-entry debug-tool-result">
										<div class="debug-label">Tool Result: {event.name}</div>
										<pre>{JSON.stringify(event.result, null, 2)}</pre>
									</div>
								{/if}
							{/each}
						</details>
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
						disabled={isRunning || !app.settings?.geminiApiKey}
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
						disabled={isRunning || !app.settings?.geminiApiKey}
						rows={3}
					></textarea>
					<button onclick={handleSend} disabled={isRunning || (!userInput.trim() && pendingFiles.length === 0)}>
						{isRunning ? '...' : 'Send'}
					</button>
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
			{#each app.projectImages as img}
				{#if img.id === lightboxImageId}
					<div class="lightbox-info">
						<span class="lightbox-label">{img.label}</span>
						{#if img.generationContext}
							<span class="lightbox-context">{img.generationContext}</span>
						{/if}
					</div>
				{/if}
			{/each}
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

	/* Debug log */
	.debug-log {
		background: #0d0d0d;
		border: 1px solid #2a2a2a;
		border-radius: 6px;
		margin-top: 1rem;
		font-size: 0.78rem;
		font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
	}

	.debug-log summary {
		padding: 0.5rem 0.75rem;
		color: #888;
		cursor: pointer;
		user-select: none;
	}

	.debug-log summary:hover {
		color: #ccc;
	}

	.debug-entry {
		border-top: 1px solid #1a1a1a;
		padding: 0.5rem 0.75rem;
	}

	.debug-label {
		color: #f5c542;
		font-weight: 600;
		margin-bottom: 0.25rem;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.debug-meta {
		color: #666;
		font-size: 0.72rem;
		margin-bottom: 0.25rem;
	}

	.debug-entry pre {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		color: #aaa;
		max-height: 20rem;
		overflow-y: auto;
		line-height: 1.4;
	}

	.debug-text {
		color: #8cbf8c;
	}

	.debug-system {
		border-left: 3px solid #665500;
	}

	.debug-request {
		border-left: 3px solid #336;
	}

	.debug-response {
		border-left: 3px solid #363;
	}

	.debug-tool {
		border-left: 3px solid #636;
	}

	.debug-tool-result {
		border-left: 3px solid #633;
	}
</style>
