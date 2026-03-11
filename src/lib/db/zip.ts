/**
 * Project export/import as zip files.
 *
 * Zip structure:
 *   project.json     - project metadata, design doc, conversations, messages
 *   images/          - image blobs as files, keyed by image ID
 *   images/index.json - image metadata (everything except the blob)
 */
import JSZip from 'jszip';
import { db } from './database';
import type {
	Project,
	DesignDocument,
	Conversation,
	Message,
	StoredImage,
	MemoryTopic
} from '$lib/types/schema';

interface ExportManifestV1 {
	version: 1;
	exportedAt: number;
	project: Project;
	designDocument: DesignDocument;
	conversations: Conversation[];
	messages: Message[];
}

interface ExportManifest {
	version: 2;
	exportedAt: number;
	project: Project;
	designDocument: DesignDocument;
	conversations: Conversation[];
	messages: Message[];
	memoryTopics: MemoryTopic[];
}

interface ImageManifestEntry {
	id: string;
	projectId: string;
	messageId?: string;
	source?: 'user' | 'generated';
	mimeType: string;
	width?: number;
	height?: number;
	label: string;
	generationContext?: string;
	createdAt: number;
	filename: string;
}

const MIME_EXTENSIONS: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/webp': '.webp'
};

function extensionForMime(mime: string): string {
	return MIME_EXTENSIONS[mime] ?? '.png';
}

export async function exportProject(projectId: string): Promise<Blob> {
	const project = await db.projects.get(projectId);
	if (!project) throw new Error(`Project ${projectId} not found`);

	const designDocument = await db.designDocuments.get(projectId);
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

	const zip = new JSZip();

	// Project manifest (no blobs).
	const manifest: ExportManifest = {
		version: 2,
		exportedAt: Date.now(),
		project,
		designDocument: designDocument ?? { projectId, content: '', updatedAt: project.updatedAt },
		conversations,
		messages,
		memoryTopics
	};
	zip.file('project.json', JSON.stringify(manifest, null, 2));

	// Design document as a standalone readable file (legacy).
	if (manifest.designDocument.content) {
		zip.file('design-doc.md', manifest.designDocument.content);
	}

	// Memory topics as individual markdown files.
	if (memoryTopics.length > 0) {
		const memoryFolder = zip.folder('memory')!;
		for (const topic of memoryTopics) {
			memoryFolder.file(`${topic.slug}.md`, `# ${topic.title}\n\n${topic.content}`);
		}
	}

	// Images.
	const imageIndex: ImageManifestEntry[] = [];
	const imagesFolder = zip.folder('images')!;

	for (const img of images) {
		const filename = img.id + extensionForMime(img.mimeType);
		imagesFolder.file(filename, img.blob);
		imageIndex.push({
			id: img.id,
			projectId: img.projectId,
			messageId: img.messageId,
			source: img.source,
			mimeType: img.mimeType,
			width: img.width,
			height: img.height,
			label: img.label,
			generationContext: img.generationContext,
			createdAt: img.createdAt,
			filename
		});
	}
	imagesFolder.file('index.json', JSON.stringify(imageIndex, null, 2));

	return zip.generateAsync({ type: 'blob' });
}

export async function importProject(zipBlob: Blob): Promise<Project> {
	const zip = await JSZip.loadAsync(zipBlob);

	const manifestFile = zip.file('project.json');
	if (!manifestFile) throw new Error('Invalid project zip: missing project.json');

	const raw = JSON.parse(await manifestFile.async('text'));
	if (raw.version !== 1 && raw.version !== 2) throw new Error(`Unsupported export version: ${raw.version}`);
	const manifest = raw as ExportManifest | ExportManifestV1;

	// Load image index and blobs.
	const imageIndexFile = zip.file('images/index.json');
	const imageEntries: ImageManifestEntry[] = imageIndexFile
		? JSON.parse(await imageIndexFile.async('text'))
		: [];

	const images: StoredImage[] = [];
	for (const entry of imageEntries) {
		const file = zip.file('images/' + entry.filename);
		if (!file) continue;
		const imageBlob = new Blob([await file.async('blob')], { type: entry.mimeType });
		const { createThumbnail } = await import('./thumbnail');
		const thumbnail = await createThumbnail(imageBlob);
		images.push({
			id: entry.id,
			projectId: entry.projectId,
			messageId: entry.messageId,
			source: entry.source ?? 'generated',
			blob: imageBlob,
			thumbnail,
			mimeType: entry.mimeType,
			width: entry.width,
			height: entry.height,
			label: entry.label,
			generationContext: entry.generationContext,
			createdAt: entry.createdAt
		});
	}

	// Extract memory topics from v2 manifests.
	const memoryTopics: MemoryTopic[] = manifest.version === 2 ? manifest.memoryTopics : [];

	// Write everything in a single transaction.
	await db.transaction(
		'rw',
		[db.projects, db.designDocuments, db.conversations, db.messages, db.images, db.memoryTopics],
		async () => {
			await db.projects.put(manifest.project);
			await db.designDocuments.put(manifest.designDocument);
			await db.conversations.bulkPut(manifest.conversations);
			await db.messages.bulkPut(manifest.messages);
			await db.images.bulkPut(images);
			if (memoryTopics.length > 0) {
				await db.memoryTopics.bulkPut(memoryTopics);
			}
		}
	);

	return manifest.project;
}

/** Trigger a download of the zip in the browser. */
export async function downloadProjectZip(projectId: string): Promise<void> {
	const project = await db.projects.get(projectId);
	const blob = await exportProject(projectId);
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = (project?.name ?? 'project').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
	a.click();
	URL.revokeObjectURL(url);
}
