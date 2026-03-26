/**
 * Reactive app state using Svelte 5 runes.
 */
import type { Project, Conversation, ChatMessage, ImageMeta, Settings, AgentMemory, AgentSession } from '$lib/types/schema';
import * as ops from '$lib/db/operations';
import { blobToObjectUrl } from '$lib/utils';
import { downloadProjectZip, importProject as importProjectZip } from '$lib/db/zip';

// Current state
let currentProject = $state<Project | null>(null);
let currentConversation = $state<Conversation | null>(null);
let projects = $state<Project[]>([]);
let conversations = $state<Conversation[]>([]);
let messages = $state<ChatMessage[]>([]);
let projectImages = $state<ImageMeta[]>([]);
let agentMemories = $state<AgentMemory[]>([]);
let orchestratorSession = $state<AgentSession | null>(null);
let settings = $state<Settings | null>(null);

// Image URL cache with LRU eviction. Map iteration order tracks insertion,
// and we re-insert on access to promote recently used entries.
const IMAGE_URL_CACHE_MAX = 200;
const imageUrlCache = new Map<string, string>();
const imageUrlInflight = new Map<string, Promise<string | null>>();

// Reactive image state: resolved blob URLs and derived collections.
// resolvedUrls is the reactive projection of the LRU cache, updated
// when resolveImageId() fetches a new URL.
let resolvedUrls = $state<Record<string, string>>({});

let favorites = $derived(new Set(
  projectImages.filter(img => img.favorite).map(img => img.id)
));

let imageLabelMap = $derived(
  new Map(projectImages.map(img => [img.id, img.label]))
);

let imagesByRecency = $derived(
  [...projectImages].sort((a, b) => b.createdAt - a.createdAt)
);

export function getAppState() {
  return {
    get currentProject() { return currentProject; },
    get currentConversation() { return currentConversation; },
    get orchestratorSession() { return orchestratorSession; },
    get agentMemories() { return agentMemories; },
    get projects() { return projects; },
    get conversations() { return conversations; },
    get messages() { return messages; },
    get projectImages() { return projectImages; },
    get settings() { return settings; },
    get resolvedUrls() { return resolvedUrls; },
    get favorites() { return favorites; },
    get imageLabelMap() { return imageLabelMap; },
    get imagesByRecency() { return imagesByRecency; }
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
  resolvedUrls = {};
  currentProject = (await ops.getProject(id)) ?? null;
  currentConversation = null;
  orchestratorSession = null;
  messages = [];
  conversations = [];
  projectImages = [];
  agentMemories = [];
  if (currentProject) {
    conversations = await ops.listConversations(id);
    projectImages = await ops.listImages(id);
    agentMemories = await ops.listAgentMemories(id);
    resolveAllImages();
  }
}

export function deselectProject(): void {
  revokeImageUrls();
  resolvedUrls = {};
  currentProject = null;
  currentConversation = null;
  orchestratorSession = null;
  messages = [];
  conversations = [];
  projectImages = [];
  agentMemories = [];
}

export async function createProject(name: string, initialized = true): Promise<Project> {
  const project = await ops.createProject(name, '', initialized);
  await loadProjects();
  await selectProject(project.id);
  return project;
}

export async function renameProject(id: string, name: string): Promise<void> {
  await ops.updateProject(id, { name });
  await loadProjects();
  if (currentProject?.id === id) {
    currentProject = (await ops.getProject(id)) ?? null;
  }
}

/** Rename and mark a project as initialized (used by auto-naming). */
export async function initializeProject(id: string, name: string, description: string): Promise<void> {
  await ops.updateProject(id, { name, description, initialized: true });
  await loadProjects();
  if (currentProject?.id === id) {
    currentProject = (await ops.getProject(id)) ?? null;
  }
}

export async function selectConversation(id: string): Promise<void> {
  const convos = await ops.listConversations(currentProject!.id);
  currentConversation = convos.find((c) => c.id === id) ?? null;
  if (currentConversation) {
    messages = await ops.listMessages(id);
    orchestratorSession = await ops.getOrchestratorSession(id);
    resolveAllImages();
  } else {
    orchestratorSession = null;
    messages = [];
  }
}

export async function createConversation(title: string): Promise<Conversation> {
  if (!currentProject) throw new Error('No project selected');
  const convo = await ops.createConversation(currentProject.id, title);
  conversations = await ops.listConversations(currentProject.id);
  await selectConversation(convo.id);
  return convo;
}

export async function deleteProject(): Promise<void> {
  if (!currentProject) return;
  const id = currentProject.id;
  revokeImageUrls();
  resolvedUrls = {};
  currentProject = null;
  currentConversation = null;
  orchestratorSession = null;
  messages = [];
  conversations = [];
  projectImages = [];
  agentMemories = [];
  await ops.deleteProject(id);
  await loadProjects();
}

export async function deleteConversation(id: string): Promise<void> {
  if (!currentProject) return;
  await ops.deleteConversation(id);
  conversations = await ops.listConversations(currentProject.id);
  if (currentConversation?.id === id) {
    currentConversation = null;
    orchestratorSession = null;
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

export async function refreshMessages(): Promise<void> {
  if (currentConversation) {
    messages = await ops.listMessages(currentConversation.id);
    resolveAllImages();
  }
}

export async function refreshConversation(): Promise<void> {
  if (currentConversation) {
    const fresh = await ops.getConversation(currentConversation.id);
    if (fresh) currentConversation = fresh;
  }
}

export async function refreshOrchestratorSession(): Promise<void> {
  if (currentConversation) {
    orchestratorSession = await ops.getOrchestratorSession(currentConversation.id);
  }
}

export async function refreshAgentMemories(): Promise<void> {
  if (currentProject) {
    agentMemories = await ops.listAgentMemories(currentProject.id);
  }
}

export async function refreshProjectImages(): Promise<void> {
  if (currentProject) {
    projectImages = await ops.listImages(currentProject.id);
    resolveAllImages();
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

  // Deduplicate concurrent fetches for the same image.
  const inflight = imageUrlInflight.get(imageId);
  if (inflight) return inflight;

  const promise = (async () => {
    const blobs = await ops.getImageBlob(imageId);
    if (!blobs) return null;

    const url = blobToObjectUrl(blobs.blob);

    // Evict oldest entries if at capacity.
    while (imageUrlCache.size >= IMAGE_URL_CACHE_MAX) {
      const oldest = imageUrlCache.keys().next().value!;
      URL.revokeObjectURL(imageUrlCache.get(oldest)!);
      imageUrlCache.delete(oldest);
    }

    imageUrlCache.set(imageId, url);
    return url;
  })();

  imageUrlInflight.set(imageId, promise);
  try {
    return await promise;
  } finally {
    imageUrlInflight.delete(imageId);
  }
}

/**
 * Resolve an image ID to a blob URL and update the reactive resolvedUrls record.
 * Deduplicates via the existing getImageUrl inflight tracking.
 */
export async function resolveImageId(id: string): Promise<void> {
  if (resolvedUrls[id]) return;
  const url = await getImageUrl(id);
  if (url) resolvedUrls = { ...resolvedUrls, [id]: url };
}

/** Resolve all image IDs referenced in current messages and project images. */
function resolveAllImages(): void {
  for (const msg of messages) {
    for (const imgId of msg.imageIds) resolveImageId(imgId);
  }
  for (const img of projectImages) resolveImageId(img.id);
}

export async function deleteImage(imageId: string): Promise<void> {
  await ops.deleteImage(imageId);
  revokeImageUrls();
  if (currentProject) {
    projectImages = await ops.listImages(currentProject.id);
  }
}

export async function toggleFavorite(imageId: string): Promise<void> {
  await ops.toggleImageFavorite(imageId);
  if (currentProject) {
    projectImages = await ops.listImages(currentProject.id);
  }
}

export async function exportProject(): Promise<void> {
  if (!currentProject) return;
  await downloadProjectZip(currentProject.id);
}

export async function importProject(zipBlob: Blob): Promise<Project> {
  const project = await importProjectZip(zipBlob);
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
