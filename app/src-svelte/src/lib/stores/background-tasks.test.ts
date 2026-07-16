import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @tauri-apps/api/event before importing the store under test (the
// listeners are only attached via init(), which these tests never call).
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async () => () => {}),
}));

import { backgroundTasks } from './background-tasks.svelte';

beforeEach(() => {
	backgroundTasks.tasks = [];
});

describe('background task lifecycle enforcement', () => {
	it('refuses to dismiss a running task', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const id = backgroundTasks.begin('summary', 'm1', 'Generating summary');

		backgroundTasks.dismiss(id);

		expect(backgroundTasks.tasks).toHaveLength(1);
		expect(backgroundTasks.tasks[0]?.status).toBe('running');
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it('dismisses terminal tasks', () => {
		const id = backgroundTasks.begin('retranscription', 'm1', 'Re-transcribing');
		backgroundTasks.finish('retranscription', 'm1', 'error', 'boom');

		backgroundTasks.dismiss(id);

		expect(backgroundTasks.tasks).toHaveLength(0);
	});

	it('cancel removes a running task (the explicit stop path)', () => {
		backgroundTasks.begin('summary', 'm1', 'Generating summary');

		backgroundTasks.cancel('summary', 'm1');

		expect(backgroundTasks.tasks).toHaveLength(0);
	});

	it('progress events upsert a task that begin() never registered', () => {
		backgroundTasks.progress('diarization', 'm2', 'Identifying speakers', null, 'decoding');

		expect(backgroundTasks.tasks).toHaveLength(1);
		expect(backgroundTasks.tasks[0]?.kind).toBe('diarization');
		expect(backgroundTasks.tasks[0]?.status).toBe('running');
	});
});
