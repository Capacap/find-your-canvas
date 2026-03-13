/**
 * Reactive app state using Svelte 5 runes.
 */
import type { Project, Conversation, Message, ImageMeta, Settings, AgentMemory } from '$lib/types/schema';
import * as ops from '$lib/db/operations';
import { downloadProjectZip, importProject } from '$lib/db/zip';

// Current state
let currentProject = $state<Project | null>(null);
let currentConversation = $state<Conversation | null>(null);
let projects = $state<Project[]>([]);
let conversations = $state<Conversation[]>([]);
let messages = $state<Message[]>([]);
let projectImages = $state<ImageMeta[]>([]);
let agentMemories = $state<AgentMemory[]>([]);
let settings = $state<Settings | null>(null);

// Image URL cache with LRU eviction. Map iteration order tracks insertion,
// and we re-insert on access to promote recently used entries.
const IMAGE_URL_CACHE_MAX = 50;
const imageUrlCache = new Map<string, string>();

export function getAppState() {
	return {
		get currentProject() { return currentProject; },
		get currentConversation() { return currentConversation; },
		get agentMemories() { return agentMemories; },
		get projects() { return projects; },
		get conversations() { return conversations; },
		get messages() { return messages; },
		get projectImages() { return projectImages; },
		get settings() { return settings; }
	};
}

export async function loadSettings(): Promise<void> {
	settings = await ops.getSettings();
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
	await ops.updateSettings(patch);
	settings = await ops.getSettings();
}

export async function loadProjects(): Promise<void> {
	projects = await ops.listProjects();
}

export async function selectProject(id: string): Promise<void> {
	revokeImageUrls();
	currentProject = (await ops.getProject(id)) ?? null;
	currentConversation = null;
	messages = [];
	conversations = [];
	projectImages = [];
	agentMemories = [];
	if (currentProject) {
		conversations = await ops.listConversations(id);
		projectImages = await ops.listProjectImages(id);
		agentMemories = await ops.listAgentMemories(id);
	}
}

export function deselectProject(): void {
	revokeImageUrls();
	currentProject = null;
	currentConversation = null;
	messages = [];
	conversations = [];
	projectImages = [];
	agentMemories = [];
}

export async function createNewProject(name: string): Promise<Project> {
	const project = await ops.createProject(name);
	await loadProjects();
	await selectProject(project.id);
	return project;
}

export async function selectConversation(id: string): Promise<void> {
	const convos = await ops.listConversations(currentProject!.id);
	currentConversation = convos.find((c) => c.id === id) ?? null;
	if (currentConversation) {
		messages = await ops.listMessages(id);
	}
}

export async function createNewConversation(title: string): Promise<Conversation> {
	if (!currentProject) throw new Error('No project selected');
	const convo = await ops.createConversation(currentProject.id, title);
	conversations = await ops.listConversations(currentProject.id);
	await selectConversation(convo.id);
	return convo;
}

export async function deleteCurrentProject(): Promise<void> {
	if (!currentProject) return;
	const id = currentProject.id;
	revokeImageUrls();
	currentProject = null;
	currentConversation = null;
	messages = [];
	conversations = [];
	projectImages = [];
	agentMemories = [];
	await ops.deleteProject(id);
	await loadProjects();
}

export async function removeConversation(id: string): Promise<void> {
	if (!currentProject) return;
	await ops.deleteConversation(id);
	conversations = await ops.listConversations(currentProject.id);
	if (currentConversation?.id === id) {
		currentConversation = null;
		messages = [];
	}
}

export async function renameConversation(id: string, title: string): Promise<void> {
	if (!currentProject) return;
	await ops.updateConversation(id, { title });
	conversations = await ops.listConversations(currentProject.id);
	if (currentConversation?.id === id) {
		currentConversation = { ...currentConversation, title };
	}
}

export function appendMessage(msg: Message): void {
	messages = [...messages, msg];
}

export async function refreshMessages(): Promise<void> {
	if (currentConversation) {
		messages = await ops.listMessages(currentConversation.id);
	}
}

export async function refreshAgentMemories(): Promise<void> {
	if (currentProject) {
		agentMemories = await ops.listAgentMemories(currentProject.id);
	}
}

export async function refreshProjectImages(): Promise<void> {
	if (currentProject) {
		projectImages = await ops.listProjectImages(currentProject.id);
	}
}

/**
 * Get an object URL for an image, caching it.
 * Fetches only the blob data, not the full metadata record.
 * Returns null if the image isn't found.
 */
export async function getImageUrl(imageId: string): Promise<string | null> {
	const cached = imageUrlCache.get(imageId);
	if (cached) {
		// Promote to most-recently-used by re-inserting.
		imageUrlCache.delete(imageId);
		imageUrlCache.set(imageId, cached);
		return cached;
	}

	const blobs = await ops.getImageBlob(imageId);
	if (!blobs) return null;

	const url = ops.blobToObjectUrl(blobs.blob);

	// Evict oldest entries if at capacity.
	while (imageUrlCache.size >= IMAGE_URL_CACHE_MAX) {
		const oldest = imageUrlCache.keys().next().value!;
		URL.revokeObjectURL(imageUrlCache.get(oldest)!);
		imageUrlCache.delete(oldest);
	}

	imageUrlCache.set(imageId, url);
	return url;
}

export async function removeImage(imageId: string): Promise<void> {
	await ops.deleteImage(imageId);
	revokeImageUrls();
	if (currentProject) {
		projectImages = await ops.listProjectImages(currentProject.id);
	}
}

export async function exportCurrentProject(): Promise<void> {
	if (!currentProject) return;
	await downloadProjectZip(currentProject.id);
}

export async function importProjectZip(zipBlob: Blob): Promise<Project> {
	const project = await importProject(zipBlob);
	await loadProjects();
	await selectProject(project.id);
	return project;
}

/** Clean up all cached object URLs. Call on project switch or cleanup. */
export function revokeImageUrls(): void {
	for (const url of imageUrlCache.values()) {
		URL.revokeObjectURL(url);
	}
	imageUrlCache.clear();
}
