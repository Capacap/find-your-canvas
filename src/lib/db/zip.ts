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
import { downloadZip } from 'client-zip';
import { createThumbnail } from './thumbnail';
import {
	getProject,
	getProjectExportData,
	getImageBlob,
	importProjectData,
	importImageBatch
} from './operations';
import type {
	Project,
	Conversation,
	Message,
	ImageMeta,
	ImageBlob,
	AgentMemory
} from '$lib/types/schema';

interface ExportManifest {
	version: 1;
	exportedAt: number;
	project: Project;
	conversations: Conversation[];
	messages: Message[];
	agentMemories: AgentMemory[];
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

	const manifest: ExportManifest = {
		version: 1,
		exportedAt: Date.now(),
		project: data.project,
		conversations: data.conversations,
		messages: data.messages,
		agentMemories: data.agentMemories
	};

	// Yield zip entries one at a time via async generator so only one
	// image blob is in memory at a time during zip construction.
	// The image index is yielded last, built from entries that actually had blobs.
	async function* entries() {
		yield { name: 'project.json', input: JSON.stringify(manifest, null, 2) };

		for (const topic of data.agentMemories) {
			yield { name: `memory/${topic.slug}.md`, input: `# ${topic.title}\n\n${topic.content}` };
		}

		const imageIndex: ImageManifestEntry[] = [];
		for (const meta of data.imageMeta) {
			const record = await getImageBlob(meta.id);
			if (!record) continue;

			const filename = meta.id + extensionForMime(meta.mimeType);
			yield { name: `images/${filename}`, input: record.blob };
			imageIndex.push({
				id: meta.id,
				projectId: meta.projectId,
				messageId: meta.messageId,
				source: meta.source,
				mimeType: meta.mimeType,
				width: meta.width,
				height: meta.height,
				label: meta.label,
				generationContext: meta.generationContext,
				createdAt: meta.createdAt,
				filename
			});
		}

		yield { name: 'images/index.json', input: JSON.stringify(imageIndex, null, 2) };
	}

	return downloadZip(entries()).blob();
}

export async function importProject(zipBlob: Blob): Promise<Project> {
	const zip = await JSZip.loadAsync(zipBlob);

	const manifestFile = zip.file('project.json');
	if (!manifestFile) throw new Error('Invalid project zip: missing project.json');

	const manifest: ExportManifest = JSON.parse(await manifestFile.async('text'));

	// Load image index and blobs.
	const imageIndexFile = zip.file('images/index.json');
	const imageEntries: ImageManifestEntry[] = imageIndexFile
		? JSON.parse(await imageIndexFile.async('text'))
		: [];

	// Write project, conversations, messages, and memories first (no images).
	await importProjectData({
		project: manifest.project,
		conversations: manifest.conversations,
		messages: manifest.messages,
		imageMeta: [],
		imageBlobs: [],
		agentMemories: manifest.agentMemories
	});

	// Process and flush images in batches to avoid holding all blobs in memory.
	const CONCURRENCY = 4;
	for (let i = 0; i < imageEntries.length; i += CONCURRENCY) {
		const batch = imageEntries.slice(i, i + CONCURRENCY);
		const results = await Promise.all(batch.map(async (entry) => {
			const file = zip.file('images/' + entry.filename);
			if (!file) return null;
			const imageBlob = new Blob([await file.async('blob')], { type: entry.mimeType });
			const { thumbnail } = await createThumbnail(imageBlob);
			return { entry, imageBlob, thumbnail };
		}));

		const batchMeta: ImageMeta[] = [];
		const batchBlobs: ImageBlob[] = [];

		for (const result of results) {
			if (!result) continue;
			const { entry, imageBlob, thumbnail } = result;
			batchMeta.push({
				id: entry.id,
				projectId: entry.projectId,
				messageId: entry.messageId,
				source: entry.source ?? 'generated',
				mimeType: entry.mimeType,
				width: entry.width,
				height: entry.height,
				label: entry.label,
				generationContext: entry.generationContext,
				thumbnail,
				createdAt: entry.createdAt
			});
			batchBlobs.push({
				id: entry.id,
				blob: imageBlob
			});
		}

		if (batchMeta.length > 0) {
			await importImageBatch(batchMeta, batchBlobs);
		}
	}

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
