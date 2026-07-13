// Normalize the Whisper model status (a string or tagged object from
// Rust) into the flat shape the shared ModelCard expects.

export type ModelCardStatus = 'available' | 'missing' | 'error' | 'corrupted';

export function normalizeModelStatus(status: unknown): {
	status: ModelCardStatus;
	downloadProgress: number | null;
} {
	if (status === 'Available') return { status: 'available', downloadProgress: null };
	if (status === 'Missing') return { status: 'missing', downloadProgress: null };
	if (status && typeof status === 'object') {
		if ('Downloading' in status) {
			return {
				status: 'missing',
				downloadProgress: (status as { Downloading: number }).Downloading,
			};
		}
		if ('Error' in status) return { status: 'error', downloadProgress: null };
		if ('Corrupted' in status) return { status: 'corrupted', downloadProgress: null };
	}
	return { status: 'missing', downloadProgress: null };
}
