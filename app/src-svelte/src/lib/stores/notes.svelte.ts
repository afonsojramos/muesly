/**
 * Notes store.
 *
 * Holds the user's in-meeting notes (markdown) typed on the recording view.
 * These are ephemeral until the recording is saved, at which point they are
 * persisted to SQLite keyed by the new meeting id (see use-recording-stop) and
 * then cleared alongside the transcript.
 */

class NotesStore {
	markdown = $state('');

	set(value: string): void {
		this.markdown = value;
	}

	clear(): void {
		this.markdown = '';
	}
}

export const notes = new NotesStore();
