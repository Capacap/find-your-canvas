/**
 * Thumbnail generation using OffscreenCanvas (or fallback to DOM canvas).
 * Resizes an image blob to fit within a max dimension, preserving aspect ratio.
 */

const MAX_DIMENSION = 512;
const THUMBNAIL_QUALITY = 0.8;
const THUMBNAIL_TYPE = 'image/jpeg';

/**
 * Create a thumbnail blob from a full-size image blob.
 * Returns a JPEG blob scaled to fit within MAX_DIMENSION px.
 */
export async function createThumbnail(source: Blob): Promise<Blob> {
	const bitmap = await createImageBitmap(source);
	const { width, height } = bitmap;

	// Calculate scaled dimensions.
	let targetW = width;
	let targetH = height;
	if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
		const scale = MAX_DIMENSION / Math.max(width, height);
		targetW = Math.round(width * scale);
		targetH = Math.round(height * scale);
	}

	// Prefer OffscreenCanvas (available in modern browsers and workers).
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(targetW, targetH);
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(bitmap, 0, 0, targetW, targetH);
		bitmap.close();
		return canvas.convertToBlob({ type: THUMBNAIL_TYPE, quality: THUMBNAIL_QUALITY });
	}

	// Fallback: DOM canvas.
	const canvas = document.createElement('canvas');
	canvas.width = targetW;
	canvas.height = targetH;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(bitmap, 0, 0, targetW, targetH);
	bitmap.close();

	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
			THUMBNAIL_TYPE,
			THUMBNAIL_QUALITY
		);
	});
}
