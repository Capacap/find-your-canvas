/**
 * Database operations. Thin wrappers around Dexie queries that keep
 * the rest of the app from importing the db instance directly.
 */
import { db } from './database';
import { DEFAULT_SETTINGS } from '$lib/types/schema';
import { createThumbnail } from './thumbnail';
import type {
	Project,
	Conversation,
	Message,
	StoredImage,
	Settings,
	ImageSource,
	MemoryTopic
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
	const settings = await db.settings.get('app');
	// Merge: stored API key + current defaults for model IDs.
	return { ...DEFAULT_SETTINGS, geminiApiKey: settings?.geminiApiKey };
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
	await db.transaction('rw', [db.projects, db.conversations, db.messages, db.images, db.memoryTopics], async () => {
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
		await db.images.where('projectId').equals(id).delete();
		await db.memoryTopics.where('projectId').equals(id).delete();
		await db.projects.delete(id);
	});
}

// ── Memory Topics ──

export async function listMemoryTopics(projectId: string): Promise<MemoryTopic[]> {
	return db.memoryTopics.where('projectId').equals(projectId).toArray();
}

export async function getMemoryTopicBySlug(projectId: string, slug: string): Promise<MemoryTopic | undefined> {
	return db.memoryTopics.where('[projectId+slug]').equals([projectId, slug]).first();
}

/**
 * Upsert a memory topic by [projectId, slug].
 * If content is empty, deletes the topic.
 */
export async function upsertMemoryTopic(
	projectId: string,
	slug: string,
	title: string,
	summary: string,
	content: string
): Promise<void> {
	const existing = await getMemoryTopicBySlug(projectId, slug);
	const timestamp = now();

	if (!content.trim()) {
		// Empty content = delete.
		if (existing) {
			await db.memoryTopics.delete(existing.id);
		}
		await db.projects.update(projectId, { updatedAt: timestamp });
		return;
	}

	if (existing) {
		await db.memoryTopics.update(existing.id, {
			title,
			summary,
			content,
			updatedAt: timestamp
		});
	} else {
		const topic: MemoryTopic = {
			id: generateId(),
			projectId,
			slug,
			title,
			summary,
			content,
			createdAt: timestamp,
			updatedAt: timestamp
		};
		await db.memoryTopics.add(topic);
	}

	await db.projects.update(projectId, { updatedAt: timestamp });
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
	await db.conversations.add(conversation);
	await db.projects.update(projectId, { updatedAt: timestamp });
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
	await db.transaction('rw', [db.conversations, db.messages, db.images], async () => {
		// Find images referenced by this conversation's messages and delete them.
		const msgs = await db.messages.where('conversationId').equals(id).toArray();
		const imageIds = msgs.flatMap((m) => m.imageIds);
		if (imageIds.length > 0) {
			await db.images.bulkDelete(imageIds);
		}
		await db.messages.where('conversationId').equals(id).delete();
		await db.conversations.delete(id);
	});
}

// ── Messages ──

export async function addMessage(
	conversationId: string,
	role: Message['role'],
	text: string,
	imageIds: string[] = []
): Promise<Message> {
	const message: Message = {
		id: generateId(),
		conversationId,
		role,
		text,
		imageIds,
		createdAt: now()
	};
	await db.messages.add(message);

	// Touch the conversation's updatedAt.
	const convo = await db.conversations.get(conversationId);
	if (convo) {
		await db.conversations.update(conversationId, { updatedAt: now() });
		await db.projects.update(convo.projectId, { updatedAt: now() });
	}

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
		width?: number;
		height?: number;
		generationContext?: string;
	} = {}
): Promise<StoredImage> {
	const thumbnail = await createThumbnail(blob);
	const image: StoredImage = {
		id: generateId(),
		projectId,
		source: options.source ?? 'generated',
		messageId: options.messageId,
		blob,
		thumbnail,
		mimeType: options.mimeType ?? blob.type ?? 'image/png',
		width: options.width,
		height: options.height,
		label,
		generationContext: options.generationContext,
		createdAt: now()
	};
	await db.images.add(image);
	return image;
}

export async function getImage(id: string): Promise<StoredImage | undefined> {
	return db.images.get(id);
}

export async function listProjectImages(projectId: string): Promise<StoredImage[]> {
	return db.images.where('projectId').equals(projectId).toArray();
}

export async function deleteImage(id: string): Promise<void> {
	const image = await db.images.get(id);
	if (!image) return;

	await db.transaction('rw', [db.images, db.messages], async () => {
		await db.images.delete(id);

		// Clean dangling refs from any messages that reference this image.
		const projectConvos = await db.conversations
			.where('projectId')
			.equals(image.projectId)
			.primaryKeys();
		if (projectConvos.length === 0) return;

		const msgs = await db.messages
			.where('conversationId')
			.anyOf(projectConvos)
			.filter((m) => m.imageIds.includes(id))
			.toArray();

		for (const msg of msgs) {
			await db.messages.update(msg.id, {
				imageIds: msg.imageIds.filter((imgId) => imgId !== id)
			});
		}
	});
}

/**
 * Create a temporary object URL for displaying an image.
 * Caller is responsible for revoking it when done.
 */
export function imageToObjectUrl(image: StoredImage): string {
	return URL.createObjectURL(image.blob);
}

/**
 * Get the thumbnail for an image as a base64 string.
 * Backfills the thumbnail if the image was stored before v2.
 */
export async function getImageThumbnailBase64(imageId: string): Promise<{ base64: string; mimeType: string } | undefined> {
	const image = await db.images.get(imageId);
	if (!image) return undefined;

	// Backfill thumbnail for v1 images that don't have one.
	if (!image.thumbnail) {
		image.thumbnail = await createThumbnail(image.blob);
		await db.images.update(imageId, { thumbnail: image.thumbnail });
	}

	const base64 = await blobToBase64String(image.thumbnail);
	return { base64, mimeType: 'image/jpeg' };
}

function blobToBase64String(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			resolve(result.split(',')[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

// ── Bulk export/import (used by zip.ts) ──

export interface ProjectExportData {
	project: Project;
	conversations: Conversation[];
	messages: Message[];
	images: StoredImage[];
	memoryTopics: MemoryTopic[];
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

	const images = await db.images.where('projectId').equals(projectId).toArray();
	const memoryTopics = await db.memoryTopics.where('projectId').equals(projectId).toArray();

	return { project, conversations, messages, images, memoryTopics };
}

export async function importProjectData(data: {
	project: Project;
	conversations: Conversation[];
	messages: Message[];
	images: StoredImage[];
	memoryTopics: MemoryTopic[];
}): Promise<void> {
	await db.transaction(
		'rw',
		[db.projects, db.conversations, db.messages, db.images, db.memoryTopics],
		async () => {
			await db.projects.put(data.project);
			await db.conversations.bulkPut(data.conversations);
			await db.messages.bulkPut(data.messages);
			await db.images.bulkPut(data.images);
			if (data.memoryTopics.length > 0) {
				await db.memoryTopics.bulkPut(data.memoryTopics);
			}
		}
	);
}
