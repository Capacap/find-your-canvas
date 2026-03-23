/**
 * Database operations. Thin wrappers around Dexie queries that keep
 * the rest of the app from importing the db instance directly.
 */
import { db } from './database';
import { DEFAULT_SETTINGS } from '$lib/types/schema';
import { createThumbnail } from './thumbnail';
import { blobToBase64 } from '$lib/utils';
import type {
  Project,
  Conversation,
  ChatMessage,
  ImageMeta,
  ImageBlob,
  Settings,
  ImageSource,
  AgentMemory,
  AgentSession
} from '$lib/types/schema';
import type { Content } from '@google/genai';

// ── Helpers ──

function generateId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

// ── Settings ──

export async function getSettings(): Promise<Settings> {
  const stored = await db.settings.get('app');
  return { ...DEFAULT_SETTINGS, ...stored, id: 'app' };
}

export async function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<void> {
  const current = await getSettings();
  await db.settings.put({ ...current, ...patch, id: 'app' });
}

// ── Projects ──

export async function createProject(name: string, description: string = ''): Promise<Project> {
  const timestamp = now();
  const project: Project = {
    id: generateId(),
    name,
    description,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await db.projects.add(project);
  return project;
}

export async function getProject(id: string): Promise<Project | undefined> {
  return db.projects.get(id);
}

export async function listProjects(): Promise<Project[]> {
  return db.projects.orderBy('updatedAt').reverse().toArray();
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'description'>>
): Promise<void> {
  await db.projects.update(id, { ...patch, updatedAt: now() });
}

export async function deleteProject(id: string): Promise<void> {
  await db.transaction('rw', [db.projects, db.conversations, db.messages, db.imageMeta, db.imageBlobs, db.agentMemories, db.agentSessions], async () => {
    const conversationIds = await db.conversations
      .where('projectId')
      .equals(id)
      .primaryKeys();

    if (conversationIds.length > 0) {
      await db.messages
        .where('conversationId')
        .anyOf(conversationIds)
        .delete();
      await db.agentSessions
        .where('conversationId')
        .anyOf(conversationIds)
        .delete();
    }

    await db.conversations.where('projectId').equals(id).delete();

    const imageIds = await db.imageMeta.where('projectId').equals(id).primaryKeys();
    if (imageIds.length > 0) {
      await db.imageBlobs.bulkDelete(imageIds);
    }
    await db.imageMeta.where('projectId').equals(id).delete();

    await db.agentMemories.where('projectId').equals(id).delete();
    await db.projects.delete(id);
  });
}

// ── Agent Memory ──

export async function listAgentMemories(projectId: string): Promise<AgentMemory[]> {
  return db.agentMemories.where('projectId').equals(projectId).toArray();
}

export async function getAgentMemory(projectId: string, slug: string): Promise<AgentMemory | undefined> {
  return db.agentMemories.where('[projectId+slug]').equals([projectId, slug]).first();
}

/**
 * Upsert an agent memory by [projectId, slug].
 * If content is empty, deletes the entry.
 */
export async function upsertAgentMemory(
  projectId: string,
  slug: string,
  title: string,
  summary: string,
  content: string
): Promise<void> {
  const timestamp = now();

  await db.transaction('rw', [db.agentMemories, db.projects], async () => {
    const existing = await db.agentMemories.where('[projectId+slug]').equals([projectId, slug]).first();

    if (!content.trim()) {
      if (existing) {
        await db.agentMemories.delete(existing.id);
      }
    } else if (existing) {
      await db.agentMemories.update(existing.id, {
        title,
        summary,
        content,
        updatedAt: timestamp,
        lastAccessedAt: timestamp
      });
    } else {
      await db.agentMemories.add({
        id: generateId(),
        projectId,
        slug,
        title,
        summary,
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastAccessedAt: timestamp
      });
    }

    await db.projects.update(projectId, { updatedAt: timestamp });
  });
}

/** Count memory topics in a project (no data loaded). */
export async function countMemories(projectId: string): Promise<number> {
  return db.agentMemories.where('projectId').equals(projectId).count();
}

/** Update lastAccessedAt for a memory topic. */
export async function touchMemory(projectId: string, slug: string): Promise<void> {
  const mem = await db.agentMemories.where('[projectId+slug]').equals([projectId, slug]).first();
  if (mem) {
    await db.agentMemories.update(mem.id, { lastAccessedAt: now() });
  }
}

/** List memories sorted by lastAccessedAt descending, with optional limit. */
export async function listMemoriesMRU(projectId: string, limit?: number): Promise<AgentMemory[]> {
  let collection = db.agentMemories
    .where('[projectId+lastAccessedAt]')
    .between([projectId, -Infinity], [projectId, Infinity])
    .reverse();
  if (limit) collection = collection.limit(limit);
  return collection.toArray();
}

/** Search memories by slug, title, or summary (case-insensitive substring match). */
export async function searchMemories(projectId: string, query: string): Promise<AgentMemory[]> {
  if (!query.trim()) return [];
  const lower = query.toLowerCase();
  return db.agentMemories
    .where('projectId')
    .equals(projectId)
    .filter(mem => {
      const slug = mem.slug?.toLowerCase() ?? '';
      const title = mem.title?.toLowerCase() ?? '';
      const summary = mem.summary?.toLowerCase() ?? '';
      return slug.includes(lower) || title.includes(lower) || summary.includes(lower);
    })
    .toArray();
}

// ── Conversations ──

export async function createConversation(projectId: string, title: string): Promise<Conversation> {
  const timestamp = now();
  const conversation: Conversation = {
    id: generateId(),
    projectId,
    title,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await db.transaction('rw', [db.conversations, db.projects], async () => {
    await db.conversations.add(conversation);
    await db.projects.update(projectId, { updatedAt: timestamp });
  });
  return conversation;
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  return db.conversations.get(id);
}

export async function listConversations(projectId: string): Promise<Conversation[]> {
  const convos = await db.conversations
    .where('projectId')
    .equals(projectId)
    .sortBy('updatedAt');
  return convos.reverse();
}

export async function updateConversation(
  id: string,
  patch: Partial<Pick<Conversation, 'title'>>
): Promise<void> {
  await db.conversations.update(id, { ...patch, updatedAt: now() });
}

export async function deleteConversation(id: string): Promise<void> {
  await db.transaction('rw', [db.conversations, db.messages, db.imageMeta, db.agentSessions, db.projects], async () => {
    const convo = await db.conversations.get(id);
    const messageIds = await db.messages.where('conversationId').equals(id).primaryKeys();
    await db.messages.where('conversationId').equals(id).delete();

    // Clear dangling messageId references on images (images stay, they're project-scoped).
    if (messageIds.length > 0) {
      const orphanedImages = await db.imageMeta.where('messageId').anyOf(messageIds).toArray();
      for (const img of orphanedImages) {
        await db.imageMeta.update(img.id, { messageId: undefined });
      }
    }

    await db.agentSessions.where('conversationId').equals(id).delete();
    await db.conversations.delete(id);
    if (convo) {
      await db.projects.update(convo.projectId, { updatedAt: now() });
    }
  });
}

// ── Agent Sessions ──

/** Get the orchestrator session for a conversation, or null if none exists yet. */
export async function getOrchestratorSession(conversationId: string): Promise<AgentSession | null> {
  const session = await db.agentSessions
    .where('[conversationId+agentType]')
    .equals([conversationId, 'orchestrator'])
    .first();
  return session ?? null;
}

/** Create a new agent session. */
export async function createAgentSession(
  conversationId: string,
  agentType: AgentSession['agentType'],
  opts?: { dispatchId?: string }
): Promise<AgentSession> {
  const timestamp = now();
  const session: AgentSession = {
    id: generateId(),
    conversationId,
    agentType,
    dispatchId: opts?.dispatchId,
    systemPrompt: '',
    history: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await db.agentSessions.add(session);
  return session;
}

/** Get an agent session by ID. */
export async function getAgentSession(id: string): Promise<AgentSession | undefined> {
  return db.agentSessions.get(id);
}

/** List all agent sessions for a conversation. */
export async function listAgentSessions(conversationId: string): Promise<AgentSession[]> {
  return db.agentSessions
    .where('conversationId')
    .equals(conversationId)
    .toArray();
}

// ── Messages ──

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  return db.messages
    .where('conversationId')
    .equals(conversationId)
    .sortBy('createdAt');
}

/**
 * Persist the result of an agent turn atomically: user message, assistant
 * message, and updated session state in a single transaction.
 *
 * On successful turns, also records preTurnHistoryLength as the rollback
 * point for the next rollbackLastTurn call. Skipped on error turns since
 * the orchestrator already rolls history back to pre-turn state.
 */
export async function saveTurnResult(
  projectId: string,
  conversationId: string,
  sessionId: string,
  result: {
    userText: string;
    userImageIds: string[];
    assistantText: string;
    assistantImageIds: string[];
    apiHistory: Content[];
    systemPrompt: string;
    subagentSessions?: Array<{
      agentType: 'text-to-image' | 'image-to-image';
      dispatchId: string;
      systemPrompt: string;
      history: Content[];
    }>;
    activityLog?: Array<{ text: string; nested: boolean }>;
    error?: string;
  },
  /** apiHistory.length before this turn ran. Stored on success for rollback. */
  preTurnHistoryLength?: number
): Promise<void> {
  const isError = !!result.error;
  const timestamp = now();

  await db.transaction('rw', [db.messages, db.conversations, db.agentSessions, db.projects], async () => {
    if (result.userText) {
      await db.messages.add({
        id: generateId(),
        conversationId,
        role: 'user',
        text: result.userText,
        imageIds: result.userImageIds,
        ...(isError ? { errorTurn: true } : {}),
        createdAt: timestamp
      });
    }
    if (result.assistantText) {
      await db.messages.add({
        id: generateId(),
        conversationId,
        role: 'assistant',
        text: result.assistantText,
        imageIds: result.assistantImageIds,
        ...(isError ? { errorTurn: true } : {}),
        ...(result.activityLog?.length ? { activityLog: result.activityLog } : {}),
        createdAt: timestamp + 1 // +1ms ensures assistant sorts after user in createdAt order
      });
    }
    await db.agentSessions.update(sessionId, {
      history: result.apiHistory,
      systemPrompt: result.systemPrompt,
      updatedAt: timestamp,
      ...(!isError && preTurnHistoryLength !== undefined ? { preTurnHistoryLength } : {})
    });

    // Persist subagent sessions spawned during this turn.
    if (result.subagentSessions) {
      for (const sub of result.subagentSessions) {
        await db.agentSessions.add({
          id: generateId(),
          conversationId,
          agentType: sub.agentType,
          dispatchId: sub.dispatchId,
          systemPrompt: sub.systemPrompt,
          history: sub.history,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      }
    }

    await db.conversations.update(conversationId, { updatedAt: timestamp });
    await db.projects.update(projectId, { updatedAt: timestamp });
  });
}

/**
 * Roll back the most recent successful turn. Cleans up any leftover
 * error-turn messages, then deletes the last user+assistant messages,
 * truncates the orchestrator session's history to preTurnHistoryLength,
 * clears dangling messageId references on images, and returns the user's
 * text and imageIds so the UI can prefill the input.
 *
 * Returns null if rollback isn't possible (no preTurnHistoryLength recorded).
 * Single-level undo: clears preTurnHistoryLength after rollback.
 */
export async function rollbackLastTurn(
  conversationId: string,
  sessionId: string
): Promise<{ userText: string; userImageIds: string[] } | null> {
  let userText = '';
  let userImageIds: string[] = [];
  let didRollback = false;

  await db.transaction('rw', [db.messages, db.conversations, db.agentSessions, db.projects, db.imageMeta], async () => {
    const session = await db.agentSessions.get(sessionId);
    if (!session || session.preTurnHistoryLength === undefined) return;

    const convo = await db.conversations.get(conversationId);
    if (!convo) return;

    // Delete any leftover error-turn messages first so the backward
    // walk hits the last *successful* turn, not a failed follow-up.
    await db.messages
      .where('conversationId')
      .equals(conversationId)
      .filter((m) => m.errorTurn === true)
      .delete();

    const messages = await db.messages
      .where('conversationId')
      .equals(conversationId)
      .sortBy('createdAt');

    const toDelete: string[] = [];

    // Walk backwards: expect assistant then user from the same turn.
    for (let i = messages.length - 1; i >= 0 && toDelete.length < 2; i--) {
      const msg = messages[i];
      if (toDelete.length === 0 && msg.role === 'assistant') {
        toDelete.push(msg.id);
      } else if (toDelete.length === 1 && msg.role === 'user') {
        userText = msg.text;
        userImageIds = msg.imageIds;
        toDelete.push(msg.id);
      } else {
        break;
      }
    }

    if (toDelete.length > 0) {
      await db.messages.bulkDelete(toDelete);

      // Clear dangling messageId references on images (same pattern as deleteConversation).
      const orphanedImages = await db.imageMeta.where('messageId').anyOf(toDelete).toArray();
      for (const img of orphanedImages) {
        await db.imageMeta.update(img.id, { messageId: undefined });
      }
    }

    const truncatedHistory = session.history.slice(0, session.preTurnHistoryLength);
    await db.agentSessions.update(sessionId, {
      history: truncatedHistory,
      preTurnHistoryLength: undefined,
      updatedAt: now()
    });
    await db.conversations.update(conversationId, { updatedAt: now() });
    await db.projects.update(convo.projectId, { updatedAt: now() });
    didRollback = true;
  });

  return didRollback ? { userText, userImageIds } : null;
}

/** Delete all messages from a failed turn. Called at the start of the next turn. */
export async function deleteErrorMessages(conversationId: string): Promise<void> {
  await db.messages
    .where('conversationId')
    .equals(conversationId)
    .filter((m) => m.errorTurn === true)
    .delete();
}

// ── Images ──

export async function createImage(
  projectId: string,
  blob: Blob,
  label: string,
  options: {
    source?: ImageSource;
    messageId?: string;
    mimeType?: string;
    generationContext?: string;
  } = {}
): Promise<ImageMeta> {
  const id = generateId();
  const { thumbnail, width, height } = await createThumbnail(blob);

  const timestamp = now();
  const meta: ImageMeta = {
    id,
    projectId,
    source: options.source ?? 'generated',
    messageId: options.messageId,
    mimeType: options.mimeType ?? blob.type ?? 'image/png',
    width,
    height,
    label,
    generationContext: options.generationContext,
    thumbnail,
    createdAt: timestamp,
    lastAccessedAt: timestamp
  };
  const blobRecord: ImageBlob = { id, blob };

  await db.transaction('rw', [db.imageMeta, db.imageBlobs, db.projects], async () => {
    await db.imageMeta.add(meta);
    await db.imageBlobs.add(blobRecord);
    await db.projects.update(projectId, { updatedAt: timestamp });
  });

  return meta;
}

/** Get full image record including blobs. */
export async function getImage(id: string): Promise<(ImageMeta & ImageBlob) | undefined> {
  const meta = await db.imageMeta.get(id);
  if (!meta) return undefined;
  const blobs = await db.imageBlobs.get(id);
  if (!blobs) return undefined;
  return { ...meta, ...blobs };
}

/** Get just the blob data for an image. */
export async function getImageBlob(id: string): Promise<ImageBlob | undefined> {
  return db.imageBlobs.get(id);
}

/** Get image metadata without loading the full-size blob. */
export async function getImageMeta(id: string): Promise<ImageMeta | undefined> {
  return db.imageMeta.get(id);
}

/** List image metadata for a project (no blobs loaded). */
export async function listImages(projectId: string): Promise<ImageMeta[]> {
  return db.imageMeta.where('projectId').equals(projectId).toArray();
}

/** Count images in a project (no data loaded). */
export async function countImages(projectId: string): Promise<number> {
  return db.imageMeta.where('projectId').equals(projectId).count();
}

/** Update lastAccessedAt for one or more images. */
export async function touchImages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const timestamp = now();
  await db.transaction('rw', db.imageMeta, async () => {
    for (const id of ids) {
      await db.imageMeta.update(id, { lastAccessedAt: timestamp });
    }
  });
}

/** List images sorted by lastAccessedAt descending, with optional limit. */
export async function listImagesMRU(projectId: string, limit?: number): Promise<ImageMeta[]> {
  let collection = db.imageMeta
    .where('[projectId+lastAccessedAt]')
    .between([projectId, -Infinity], [projectId, Infinity])
    .reverse();
  if (limit) collection = collection.limit(limit);
  return collection.toArray();
}

/** List favorited images for a project, most recently used first. */
export async function listFavoriteImages(projectId: string, limit?: number): Promise<ImageMeta[]> {
  const all = await db.imageMeta
    .where('[projectId+lastAccessedAt]')
    .between([projectId, -Infinity], [projectId, Infinity])
    .reverse()
    .filter(img => img.favorite === true)
    .toArray();
  return limit ? all.slice(0, limit) : all;
}

/** Toggle the favorite flag on an image. Returns the new value. */
export async function toggleImageFavorite(id: string): Promise<boolean> {
  const img = await db.imageMeta.get(id);
  if (!img) throw new Error(`Image not found: ${id}`);
  const newValue = !img.favorite;
  await db.imageMeta.update(id, { favorite: newValue });
  return newValue;
}

/** Search images by label or generationContext (case-insensitive substring match). */
export async function searchImages(projectId: string, query: string): Promise<ImageMeta[]> {
  if (!query.trim()) return [];
  const lower = query.toLowerCase();
  return db.imageMeta
    .where('projectId')
    .equals(projectId)
    .filter(img => {
      const label = img.label?.toLowerCase() ?? '';
      const ctx = img.generationContext?.toLowerCase() ?? '';
      return label.includes(lower) || ctx.includes(lower);
    })
    .toArray();
}

export async function deleteImage(id: string): Promise<void> {
  await db.transaction('rw', [db.imageMeta, db.imageBlobs], async () => {
    await db.imageMeta.delete(id);
    await db.imageBlobs.delete(id);
  });
}

/**
 * Get the thumbnail for an image as a base64 string.
 */
export async function getImageThumbnail(id: string): Promise<{ base64: string; mimeType: string } | undefined> {
  const meta = await db.imageMeta.get(id);
  if (!meta) return undefined;

  const base64 = await blobToBase64(meta.thumbnail);
  return { base64, mimeType: 'image/jpeg' };
}

// ── Bulk export/import (used by zip.ts) ──

export interface ProjectExportData {
  project: Project;
  conversations: Conversation[];
  messages: ChatMessage[];
  imageMeta: ImageMeta[];
  agentMemories: AgentMemory[];
  agentSessions: AgentSession[];
}

export async function getProjectExportData(projectId: string): Promise<ProjectExportData> {
  const project = await db.projects.get(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const conversations = await db.conversations
    .where('projectId')
    .equals(projectId)
    .toArray();

  const conversationIds = conversations.map((c) => c.id);
  const messages =
    conversationIds.length > 0
      ? (await db.messages.where('conversationId').anyOf(conversationIds).toArray())
        .filter((m) => !m.errorTurn)
      : [];

  const agentSessions =
    conversationIds.length > 0
      ? await db.agentSessions.where('conversationId').anyOf(conversationIds).toArray()
      : [];

  const imageMeta = await db.imageMeta.where('projectId').equals(projectId).toArray();
  const agentMemories = await db.agentMemories.where('projectId').equals(projectId).toArray();

  return { project, conversations, messages, imageMeta, agentMemories, agentSessions };
}

export interface ProjectImportData extends ProjectExportData {
  imageBlobs: ImageBlob[];
}

export async function importProjectData(data: ProjectImportData): Promise<void> {
  await db.transaction(
    'rw',
    [db.projects, db.conversations, db.messages, db.imageMeta, db.imageBlobs, db.agentMemories, db.agentSessions],
    async () => {
      await db.projects.put(data.project);
      await db.conversations.bulkPut(data.conversations);
      await db.messages.bulkPut(data.messages);
      await db.imageMeta.bulkPut(data.imageMeta);
      await db.imageBlobs.bulkPut(data.imageBlobs);
      if (data.agentMemories.length > 0) {
        await db.agentMemories.bulkPut(data.agentMemories);
      }
      if (data.agentSessions.length > 0) {
        await db.agentSessions.bulkPut(data.agentSessions);
      }
    }
  );
}

/** Write a batch of images during import. Separate from importProjectData to allow incremental flushing. */
export async function importImageBatch(meta: ImageMeta[], blobs: ImageBlob[]): Promise<void> {
  await db.transaction('rw', [db.imageMeta, db.imageBlobs], async () => {
    await db.imageMeta.bulkPut(meta);
    await db.imageBlobs.bulkPut(blobs);
  });
}
