export function appendMarkdown(existing: string, addition: string): string {
	const normalizedExisting = existing.replace(/\n+$/, '');
	const normalizedAddition = addition.replace(/^\n+/, '');
	if (!normalizedExisting) return normalizedAddition;
	if (!normalizedAddition) return normalizedExisting;
	return `${normalizedExisting}\n\n${normalizedAddition}`;
}

export type MarkdownInsertionOutcome = 'saved' | 'retained-after-concurrent-edit';

export async function persistMarkdownInsertion(options: {
	addition: string;
	read: () => string;
	write: (markdown: string) => void;
	save: (markdown: string) => Promise<void>;
}): Promise<MarkdownInsertionOutcome> {
	const original = options.read();
	const inserted = appendMarkdown(original, options.addition);
	options.write(inserted);
	try {
		await options.save(inserted);
		return 'saved';
	} catch (error) {
		if (options.read() === inserted) {
			options.write(original);
			throw error;
		}
		return 'retained-after-concurrent-edit';
	}
}

export class ResponseInsertionGuard {
	readonly #pending = new Set<string>();
	readonly #inserted = new Set<string>();

	isDisabled(messageId: string): boolean {
		return this.#pending.has(messageId) || this.#inserted.has(messageId);
	}

	isPending(messageId: string): boolean {
		return this.#pending.has(messageId);
	}

	async run(messageId: string, insert: () => Promise<void>): Promise<boolean> {
		if (this.isDisabled(messageId)) return false;
		this.#pending.add(messageId);
		try {
			await insert();
			this.#inserted.add(messageId);
			return true;
		} finally {
			this.#pending.delete(messageId);
		}
	}
}

export interface NotesInsertionRequest {
	meetingId: string | null;
	markdown: string;
	handled: boolean;
	complete: (error?: unknown) => void;
}

export const NOTES_INSERTION_EVENT = 'muesly:insert-chat-response-into-notes';

export function requestNotesInsertion(meetingId: string | null, markdown: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const detail: NotesInsertionRequest = {
			meetingId,
			markdown,
			handled: false,
			complete: (error) => (error === undefined ? resolve() : reject(error)),
		};
		window.dispatchEvent(new CustomEvent<NotesInsertionRequest>(NOTES_INSERTION_EVENT, { detail }));
		if (!detail.handled) reject(new Error('The notes editor is not available.'));
	});
}
