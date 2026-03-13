/**
 * Binary/blob conversion utilities used across the engine.
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
 * Convert base64 or Uint8Array image data to a Blob.
 */
export function imageDataToBlob(data: Uint8Array | string, mimeType: string): Blob {
	if (typeof data === 'string') {
		const binary = atob(data);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new Blob([bytes], { type: mimeType });
	}
	return new Blob([data as BlobPart], { type: mimeType });
}
