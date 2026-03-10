import Dexie, { type EntityTable } from 'dexie';
import type {
	Project,
	DesignDocument,
	Conversation,
	Message,
	StoredImage,
	Settings
} from '$lib/types/schema';

class BananaDB extends Dexie {
	projects!: EntityTable<Project, 'id'>;
	designDocuments!: EntityTable<DesignDocument, 'projectId'>;
	conversations!: EntityTable<Conversation, 'id'>;
	messages!: EntityTable<Message, 'id'>;
	images!: EntityTable<StoredImage, 'id'>;
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
	}
}

export const db = new BananaDB();
