/**
 * Project export/import as zip files.
 *
 * Zip structure:
 *   project.json      - project metadata, conversations, messages, memory topics
 *   memory/            - per-topic markdown files (human-readable)
 *   images/            - image blobs as files, keyed by image ID
 *   images/index.json  - image metadata (everything except the blob)
 */
import JSZip from 'jszip';
import { createThumbnail } from './thumbnail';
import {
	getProject,
	getProjectExportData,
	importProjectData,
	type ProjectExportData
} from './operations';
import type {
	Project,
	Conversation,
	Message,
	StoredImage,
	MemoryTopic
} from '$lib/types/schema';

interface ExportManifest {
	version: 1;
	exportedAt: number;
	project: Project;
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
	const data = await getProjectExportData(projectId);

	const zip = new JSZip();

	const manifest: ExportManifest = {
		version: 1,
		exportedAt: Date.now(),
		project: data.project,
		conversations: data.conversations,
		messages: data.messages,
		memoryTopics: data.memoryTopics
	};
	zip.file('project.json', JSON.stringify(manifest, null, 2));

	// Memory topics as individual markdown files.
	if (data.memoryTopics.length > 0) {
		const memoryFolder = zip.folder('memory')!;
		for (const topic of data.memoryTopics) {
			memoryFolder.file(`${topic.slug}.md`, `# ${topic.title}\n\n${topic.content}`);
		}
	}

	// Images.
	const imageIndex: ImageManifestEntry[] = [];
	const imagesFolder = zip.folder('images')!;

	for (const img of data.images) {
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

	const manifest: ExportManifest = JSON.parse(await manifestFile.async('text'));
	if (manifest.version !== 1) throw new Error(`Unsupported export version: ${manifest.version}`);

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

	await importProjectData({
		project: manifest.project,
		conversations: manifest.conversations,
		messages: manifest.messages,
		images,
		memoryTopics: manifest.memoryTopics
	});

	return manifest.project;
}

/** Trigger a download of the zip in the browser. */
export async function downloadProjectZip(projectId: string): Promise<void> {
	const project = await getProject(projectId);
	const blob = await exportProject(projectId);
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = (project?.name ?? 'project').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
	a.click();
	URL.revokeObjectURL(url);
}
