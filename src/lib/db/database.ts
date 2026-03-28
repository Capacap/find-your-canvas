import Dexie, { type EntityTable } from 'dexie';
import type {
  Project,
  Conversation,
  ChatMessage,
  ImageMeta,
  ImageBlob,
  Settings,
  AgentMemory,
  AgentSession
} from '$lib/types/schema';

class BananaDB extends Dexie {
  projects!: EntityTable<Project, 'id'>;
  conversations!: EntityTable<Conversation, 'id'>;
  messages!: EntityTable<ChatMessage, 'id'>;
  imageMeta!: EntityTable<ImageMeta, 'id'>;
  imageBlobs!: EntityTable<ImageBlob, 'id'>;
  agentMemories!: EntityTable<AgentMemory, 'id'>;
  agentSessions!: EntityTable<AgentSession, 'id'>;
  settings!: EntityTable<Settings, 'id'>;

  constructor() {
    super('find-your-canvas');

    this.version(1).stores({
      projects: 'id, updatedAt',
      conversations: 'id, projectId, updatedAt',
      messages: 'id, conversationId, createdAt',
      imageMeta: 'id, projectId, messageId',
      imageBlobs: 'id',
      agentMemories: 'id, projectId, [projectId+slug]',
      agentSessions: 'id, conversationId, [conversationId+agentType]',
      settings: 'id'
    });

    this.version(2).stores({
      imageMeta: 'id, projectId, messageId, [projectId+lastAccessedAt]',
      agentMemories: 'id, projectId, [projectId+slug], [projectId+lastAccessedAt]'
    }).upgrade(tx => {
      const now = Date.now();
      return Promise.all([
        tx.table('imageMeta').toCollection().modify(img => {
          img.lastAccessedAt = img.lastAccessedAt ?? img.createdAt ?? now;
        }),
        tx.table('agentMemories').toCollection().modify(mem => {
          mem.lastAccessedAt = mem.lastAccessedAt ?? mem.updatedAt ?? mem.createdAt ?? now;
        })
      ]);
    });
  }
}

export const db = new BananaDB();
