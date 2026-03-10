/**
 * Reactive app state using Svelte 5 runes.
 */
import type { Project, Conversation, Message, DesignDocument, StoredImage, Settings } from '$lib/types/schema';
import * as ops from '$lib/db/operations';

// Current state
let currentProject = $state<Project | null>(null);
let currentConversation = $state<Conversation | null>(null);
let projects = $state<Project[]>([]);
let conversations = $state<Conversation[]>([]);
let messages = $state<Message[]>([]);
let designDoc = $state<DesignDocument | null>(null);
let settings = $state<Settings | null>(null);
let isLoading = $state(false);

// Image URL cache: imageId -> objectURL
const imageUrlCache = new Map<string, string>();

export function getAppState() {
	return {
		get currentProject() { return currentProject; },
		get currentConversation() { return currentConversation; },
		get designDoc() { return designDoc; },
		get projects() { return projects; },
		get conversations() { return conversations; },
		get messages() { return messages; },
		get settings() { return settings; },
		get isLoading() { return isLoading; },
		set isLoading(v: boolean) { isLoading = v; }
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
	currentProject = (await ops.getProject(id)) ?? null;
	currentConversation = null;
	messages = [];
	if (currentProject) {
		conversations = await ops.listConversations(id);
		designDoc = (await ops.getDesignDocument(id)) ?? null;
	} else {
		designDoc = null;
	}
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

export function appendMessage(msg: Message): void {
	messages = [...messages, msg];
}

export async function refreshMessages(): Promise<void> {
	if (currentConversation) {
		messages = await ops.listMessages(currentConversation.id);
	}
}

export async function refreshDesignDoc(): Promise<void> {
	if (currentProject) {
		designDoc = (await ops.getDesignDocument(currentProject.id)) ?? null;
	}
}

/**
 * Get an object URL for an image, caching it.
 * Returns null if the image isn't found.
 */
export async function getImageUrl(imageId: string): Promise<string | null> {
	const cached = imageUrlCache.get(imageId);
	if (cached) return cached;

	const image = await ops.getImage(imageId);
	if (!image) return null;

	const url = ops.imageToObjectUrl(image);
	imageUrlCache.set(imageId, url);
	return url;
}

/** Clean up all cached object URLs. Call on project switch or cleanup. */
export function revokeImageUrls(): void {
	for (const url of imageUrlCache.values()) {
		URL.revokeObjectURL(url);
	}
	imageUrlCache.clear();
}
