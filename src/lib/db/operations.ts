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
	Message,
	ImageMeta,
	ImageBlob,
	Settings,
	ImageSource,
	AgentMemory
} from '$lib/types/schema';

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
	await db.transaction('rw', [db.projects, db.conversations, db.messages, db.imageMeta, db.imageBlobs, db.agentMemories], async () => {
		const conversationIds = await db.conversations
			.where('projectId')
			.equals(id)
			.primaryKeys();

		if (conversationIds.length > 0) {
			await db.messages
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

export async function getAgentMemoryBySlug(projectId: string, slug: string): Promise<AgentMemory | undefined> {
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
				updatedAt: timestamp
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
				updatedAt: timestamp
			});
		}

		await db.projects.update(projectId, { updatedAt: timestamp });
	});
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
	await db.transaction('rw', [db.conversations, db.messages, db.imageMeta, db.projects], async () => {
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

		await db.conversations.delete(id);
		if (convo) {
			await db.projects.update(convo.projectId, { updatedAt: now() });
		}
	});
}

// ── Messages ──

export async function addMessage(
	projectId: string,
	conversationId: string,
	role: Message['role'],
	text: string,
	imageIds: string[] = []
): Promise<Message> {
	const timestamp = now();
	const message: Message = {
		id: generateId(),
		conversationId,
		role,
		text,
		imageIds,
		createdAt: timestamp
	};
	await db.transaction('rw', [db.messages, db.conversations, db.projects], async () => {
		await db.messages.add(message);
		await db.conversations.update(conversationId, { updatedAt: timestamp });
		await db.projects.update(projectId, { updatedAt: timestamp });
	});

	return message;
}

export async function listMessages(conversationId: string): Promise<Message[]> {
	return db.messages
		.where('conversationId')
		.equals(conversationId)
		.sortBy('createdAt');
}

// ── Images ──

export async function storeImage(
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
		createdAt: now()
	};
	const blobRecord: ImageBlob = { id, blob };

	await db.transaction('rw', [db.imageMeta, db.imageBlobs, db.projects], async () => {
		await db.imageMeta.add(meta);
		await db.imageBlobs.add(blobRecord);
		await db.projects.update(projectId, { updatedAt: meta.createdAt });
	});

	return meta;
}

/** Get image metadata only (no blobs). */
export async function getImageMeta(id: string): Promise<ImageMeta | undefined> {
	return db.imageMeta.get(id);
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

/** List image metadata for a project (no blobs loaded). */
export async function listProjectImages(projectId: string): Promise<ImageMeta[]> {
	return db.imageMeta.where('projectId').equals(projectId).toArray();
}

export async function deleteImage(id: string): Promise<void> {
	await db.transaction('rw', [db.imageMeta, db.imageBlobs], async () => {
		await db.imageMeta.delete(id);
		await db.imageBlobs.delete(id);
	});
}

/**
 * Create a temporary object URL for displaying an image.
 * Caller is responsible for revoking it when done.
 */
export function blobToObjectUrl(blob: Blob): string {
	return URL.createObjectURL(blob);
}

/**
 * Get the thumbnail for an image as a base64 string.
 */
export async function getImageThumbnailBase64(imageId: string): Promise<{ base64: string; mimeType: string } | undefined> {
	const meta = await db.imageMeta.get(imageId);
	if (!meta) return undefined;

	const base64 = await blobToBase64(meta.thumbnail);
	return { base64, mimeType: 'image/jpeg' };
}

// ── Bulk export/import (used by zip.ts) ──

export interface ProjectExportData {
	project: Project;
	conversations: Conversation[];
	messages: Message[];
	imageMeta: ImageMeta[];
	agentMemories: AgentMemory[];
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
			? await db.messages.where('conversationId').anyOf(conversationIds).toArray()
			: [];

	const imageMeta = await db.imageMeta.where('projectId').equals(projectId).toArray();
	const agentMemories = await db.agentMemories.where('projectId').equals(projectId).toArray();

	return { project, conversations, messages, imageMeta, agentMemories };
}

export interface ProjectImportData extends ProjectExportData {
	imageBlobs: ImageBlob[];
}

export async function importProjectData(data: ProjectImportData): Promise<void> {
	await db.transaction(
		'rw',
		[db.projects, db.conversations, db.messages, db.imageMeta, db.imageBlobs, db.agentMemories],
		async () => {
			await db.projects.put(data.project);
			await db.conversations.bulkPut(data.conversations);
			await db.messages.bulkPut(data.messages);
			await db.imageMeta.bulkPut(data.imageMeta);
			await db.imageBlobs.bulkPut(data.imageBlobs);
			if (data.agentMemories.length > 0) {
				await db.agentMemories.bulkPut(data.agentMemories);
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
