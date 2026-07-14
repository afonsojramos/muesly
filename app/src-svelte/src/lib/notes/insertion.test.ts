import { describe, expect, it, vi } from 'vitest';

import { appendMarkdown, persistMarkdownInsertion, ResponseInsertionGuard } from './insertion';

describe('appendMarkdown', () => {
	it('inserts into empty notes without a leading boundary', () => {
		expect(appendMarkdown('', '**Decision:** ship it')).toBe('**Decision:** ship it');
	});

	it('preserves Markdown with exactly one blank-line boundary', () => {
		expect(appendMarkdown('- Existing\n\n\n', '\n## Answer\n\n- one\n- two\n')).toBe(
			'- Existing\n\n## Answer\n\n- one\n- two\n',
		);
	});

	it('does not add empty content', () => {
		expect(appendMarkdown('Existing\n', '\n\n')).toBe('Existing');
	});
});

describe('persistMarkdownInsertion', () => {
	it('rolls back a failed save and permits a retry', async () => {
		let markdown = 'Original';
		const save = vi
			.fn<(markdown: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('disk full'))
			.mockResolvedValueOnce();
		const insert = () =>
			persistMarkdownInsertion({
				addition: '**Answer**',
				read: () => markdown,
				write: (value) => (markdown = value),
				save,
			});

		await expect(insert()).rejects.toThrow('disk full');
		expect(markdown).toBe('Original');
		await expect(insert()).resolves.toBe('saved');
		expect(markdown).toBe('Original\n\n**Answer**');
	});

	it('never overwrites an edit made while the inserted version is saving', async () => {
		let markdown = 'Original';
		const outcome = await persistMarkdownInsertion({
			addition: 'Answer',
			read: () => markdown,
			write: (value) => (markdown = value),
			save: async () => {
				markdown += '\n\nUser edit';
				throw new Error('offline');
			},
		});

		expect(outcome).toBe('retained-after-concurrent-edit');
		expect(markdown).toBe('Original\n\nAnswer\n\nUser edit');
	});
});

describe('ResponseInsertionGuard', () => {
	it('coalesces a double click and keeps a successful insertion disabled', async () => {
		const guard = new ResponseInsertionGuard();
		let finish!: () => void;
		const insert = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));

		const first = guard.run('answer-1', insert);
		expect(guard.isPending('answer-1')).toBe(true);
		expect(await guard.run('answer-1', insert)).toBe(false);
		finish();
		expect(await first).toBe(true);
		expect(await guard.run('answer-1', insert)).toBe(false);
		expect(insert).toHaveBeenCalledTimes(1);
	});

	it('allows retry after failure', async () => {
		const guard = new ResponseInsertionGuard();
		await expect(
			guard.run('answer-1', () => Promise.reject(new Error('save failed'))),
		).rejects.toThrow('save failed');
		expect(guard.isDisabled('answer-1')).toBe(false);
		expect(await guard.run('answer-1', () => Promise.resolve())).toBe(true);
	});
});
