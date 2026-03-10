/**
 * Core data types for the creative assistant.
 *
 * Design principles:
 * - Images are always referenced by ID, never stored inline as base64.
 * - Conversation history stays small by using image references like [image:id].
 * - All timestamps are Unix milliseconds for IndexedDB indexing.
 */

/** Top-level container. A game, a story, a visual exploration. */
export interface Project {
	id: string;
	name: string;
	description: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * The design document: a living summary of established decisions.
 * The agent maintains this as the project evolves. One per project.
 */
export interface DesignDocument {
	projectId: string;
	content: string;
	updatedAt: number;
}

/** A conversation thread within a project. */
export interface Conversation {
	id: string;
	projectId: string;
	title: string;
	createdAt: number;
	updatedAt: number;
}

/** Role in a conversation turn. */
export type MessageRole = 'user' | 'assistant';

/**
 * A single message in a conversation.
 *
 * The text field may contain image references like [image:abc123] which
 * get resolved to object URLs at render time.
 */
export interface Message {
	id: string;
	conversationId: string;
	role: MessageRole;
	text: string;
	/** IDs of images generated or attached in this message. */
	imageIds: string[];
	createdAt: number;
}

/** An image stored as a blob in IndexedDB. */
export interface StoredImage {
	id: string;
	projectId: string;
	/** The message that produced this image, if any. */
	messageId?: string;
	blob: Blob;
	/** Downscaled version (max 512px) for sending to the model as context. */
	thumbnail: Blob;
	mimeType: string;
	width?: number;
	height?: number;
	/** Human-readable label assigned by the agent or user. */
	label: string;
	/** The prompt or context that produced this image. */
	generationContext?: string;
	createdAt: number;
}

/** App-level settings persisted in IndexedDB. */
export interface Settings {
	id: 'app';
	geminiApiKey?: string;
	/** Which model to use for text orchestration. */
	textModel: string;
	/** Which model to use for image generation. */
	imageModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
	id: 'app',
	geminiApiKey: undefined,
	textModel: 'gemini-3.1-flash-lite-preview',
	imageModel: 'gemini-3.1-flash-image-preview'
};
