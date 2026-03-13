import Dexie, { type EntityTable } from 'dexie';
import type {
	Project,
	Conversation,
	Message,
	ImageMeta,
	ImageBlob,
	Settings,
	AgentMemory
} from '$lib/types/schema';

class BananaDB extends Dexie {
	projects!: EntityTable<Project, 'id'>;
	conversations!: EntityTable<Conversation, 'id'>;
	messages!: EntityTable<Message, 'id'>;
	imageMeta!: EntityTable<ImageMeta, 'id'>;
	imageBlobs!: EntityTable<ImageBlob, 'id'>;
	agentMemories!: EntityTable<AgentMemory, 'id'>;
	settings!: EntityTable<Settings, 'id'>;

	constructor() {
		super('banana-orchestra');

		this.version(1).stores({
			projects: 'id, updatedAt',
			conversations: 'id, projectId, updatedAt',
			messages: 'id, conversationId, createdAt',
			imageMeta: 'id, projectId, messageId',
			imageBlobs: 'id',
			agentMemories: 'id, projectId, [projectId+slug]',
			settings: 'id'
		});
	}
}

export const db = new BananaDB();
