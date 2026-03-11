import Dexie, { type EntityTable } from 'dexie';
import type {
	Project,
	DesignDocument,
	Conversation,
	Message,
	StoredImage,
	Settings,
	MemoryTopic
} from '$lib/types/schema';

class BananaDB extends Dexie {
	projects!: EntityTable<Project, 'id'>;
	designDocuments!: EntityTable<DesignDocument, 'projectId'>;
	conversations!: EntityTable<Conversation, 'id'>;
	messages!: EntityTable<Message, 'id'>;
	images!: EntityTable<StoredImage, 'id'>;
	memoryTopics!: EntityTable<MemoryTopic, 'id'>;
	settings!: EntityTable<Settings, 'id'>;

	constructor() {
		super('banana-orchestra');

		this.version(1).stores({
			projects: 'id, updatedAt',
			designDocuments: 'projectId',
			conversations: 'id, projectId, updatedAt',
			messages: 'id, conversationId, createdAt',
			images: 'id, projectId, messageId',
			settings: 'id'
		});

		// v2: adds thumbnail field to images (not indexed, no store change needed).
		// Existing images will have thumbnail backfilled on first access.
		this.version(2).stores({});

		// v3: adds memoryTopics table for structured project memory.
		this.version(3).stores({
			memoryTopics: 'id, projectId, [projectId+slug]'
		});
	}
}

export const db = new BananaDB();
