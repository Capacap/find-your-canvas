/**
 * Binary/blob conversion utilities shared across db and engine layers.
 */

/**
 * Convert a Blob to a base64 string (without the data URI prefix).
 */
export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			resolve(result.split(',')[1]);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

/**
 * Convert a base64 string to a Blob.
 * Uses fetch() to avoid the 3x memory overhead of atob + typed array.
 */
export async function base64ToBlob(base64: string, mimeType: string): Promise<Blob> {
	const res = await fetch(`data:${mimeType};base64,${base64}`);
	return res.blob();
}

/**
 * Create a temporary object URL for displaying an image.
 * Caller is responsible for revoking it when done.
 */
export function blobToObjectUrl(blob: Blob): string {
	return URL.createObjectURL(blob);
}
