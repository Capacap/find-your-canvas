import Dexie, { type EntityTable } from 'dexie';
import type {
	Project,
	Conversation,
	Message,
	StoredImage,
	Settings,
	MemoryTopic
} from '$lib/types/schema';

class BananaDB extends Dexie {
	projects!: EntityTable<Project, 'id'>;
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

		this.version(2).stores({});

		// v3: replaces designDocuments with memoryTopics.
		this.version(3).stores({
			designDocuments: null,
			memoryTopics: 'id, projectId, [projectId+slug]'
		});
	}
}

export const db = new BananaDB();
