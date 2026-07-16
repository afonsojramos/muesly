/**
 * Background task registry: long-running local jobs (retranscription, summary
 * generation) that keep running after their originating UI is closed. The
 * sidebar tasks button lists them with live progress.
 *
 * Entries are upserted by global Tauri event listeners, so a job started from
 * any surface (retranscribe dialog, post-meeting quality pass) stays visible
 * even if that surface never registered it explicitly. `begin()` only improves
 * the label and start time.
 */
import { listen } from '@tauri-apps/api/event';

export type BackgroundTaskKind = 'retranscription' | 'summary' | 'diarization';
export type BackgroundTaskStatus = 'running' | 'done' | 'error';

export interface BackgroundTask {
	/** Stable identity: `${kind}:${meetingId}`. */
	id: string;
	kind: BackgroundTaskKind;
	label: string;
	meetingId: string;
	status: BackgroundTaskStatus;
	/** 0-100 when the job reports progress; null = indeterminate. */
	progress: number | null;
	detail: string;
	startedAt: number;
}

/** Completed tasks linger briefly so the user sees them finish. */
const DONE_LINGER_MS = 8000;

interface RetranscriptionProgressPayload {
	meeting_id?: string;
	stage?: string;
	progress_percentage?: number;
	message?: string;
}

class BackgroundTasksStore {
	tasks = $state<BackgroundTask[]>([]);
	#initialized = false;

	get runningCount(): number {
		return this.tasks.filter((t) => t.status === 'running').length;
	}

	/** Register (or refresh) a task as running. Returns its id. */
	begin(kind: BackgroundTaskKind, meetingId: string, label: string): string {
		const id = `${kind}:${meetingId}`;
		const existing = this.tasks.find((t) => t.id === id);
		if (existing) {
			existing.label = label;
			existing.status = 'running';
			existing.progress = null;
			existing.detail = '';
			existing.startedAt = Date.now();
		} else {
			this.tasks.push({
				id,
				kind,
				label,
				meetingId,
				status: 'running',
				progress: null,
				detail: '',
				startedAt: Date.now(),
			});
		}
		return id;
	}

	/** Upsert running progress (creates the task if events arrive before begin). */
	progress(
		kind: BackgroundTaskKind,
		meetingId: string,
		fallbackLabel: string,
		progress: number | null,
		detail: string,
	): void {
		const id = `${kind}:${meetingId}`;
		const task = this.tasks.find((t) => t.id === id) ?? {
			id,
			kind,
			label: fallbackLabel,
			meetingId,
			status: 'running' as BackgroundTaskStatus,
			progress: null,
			detail: '',
			startedAt: Date.now(),
		};
		if (!this.tasks.includes(task)) this.tasks.push(task);
		task.status = 'running';
		task.progress = progress;
		task.detail = detail;
	}

	/** Mark a task terminal. `done` entries auto-clear; errors stay dismissable. */
	finish(
		kind: BackgroundTaskKind,
		meetingId: string,
		status: 'done' | 'error',
		detail: string,
	): void {
		const id = `${kind}:${meetingId}`;
		const task = this.tasks.find((t) => t.id === id);
		if (!task) return;
		task.status = status;
		task.detail = detail;
		task.progress = status === 'done' ? 100 : task.progress;
		if (status === 'done') {
			setTimeout(() => this.dismiss(id), DONE_LINGER_MS);
		}
	}

	/**
	 * Remove a terminal task from the list. REFUSES running tasks: work in this
	 * registry continues independently of any view, so a running entry may only
	 * disappear by reaching a terminal state (via the global events) or through
	 * `cancel()` from the flow that genuinely stopped the work. This guard is
	 * what keeps a navigation/unmount from silently orphaning live work.
	 */
	dismiss(id: string): void {
		const task = this.tasks.find((t) => t.id === id);
		if (task?.status === 'running') {
			console.warn(
				`[BackgroundTasks] Refusing to dismiss running task '${id}'; ` +
					'running work must finish or be cancelled via cancel().',
			);
			return;
		}
		this.tasks = this.tasks.filter((t) => t.id !== id);
	}

	/**
	 * Remove a task whose underlying work was genuinely stopped (user-initiated
	 * cancel, or cleanup of a job that never started). The explicit name forces
	 * call sites to mean it; view lifecycles must never call this.
	 */
	cancel(kind: BackgroundTaskKind, meetingId: string): void {
		this.tasks = this.tasks.filter((t) => t.id !== `${kind}:${meetingId}`);
	}

	/**
	 * Attach the global event listeners (idempotent). Called from the sidebar
	 * tasks button, which is mounted for the app's lifetime; listeners are
	 * intentionally never detached.
	 */
	init(): void {
		if (this.#initialized || typeof window === 'undefined') return;
		this.#initialized = true;

		void listen<RetranscriptionProgressPayload>('retranscription-progress', (e) => {
			const meetingId = e.payload?.meeting_id;
			if (!meetingId) return;
			this.progress(
				'retranscription',
				meetingId,
				'Re-transcribing meeting',
				typeof e.payload.progress_percentage === 'number'
					? Math.min(e.payload.progress_percentage, 100)
					: null,
				e.payload.message ?? e.payload.stage ?? '',
			);
		});
		void listen<{ meeting_id?: string }>('retranscription-complete', (e) => {
			const meetingId = e.payload?.meeting_id;
			if (!meetingId) return;
			this.finish('retranscription', meetingId, 'done', 'Transcript updated');
		});
		void listen<{ meeting_id?: string; error?: string }>('retranscription-error', (e) => {
			const meetingId = e.payload?.meeting_id;
			if (!meetingId) return;
			this.finish('retranscription', meetingId, 'error', e.payload?.error ?? 'Failed');
		});

		// Diarization runs from two surfaces (the meeting menu and the silent
		// auto-run after a recording stops); the sidecar reports stages but no
		// percentage, so the task shows as indeterminate with a stage message.
		void listen<{ meeting_id?: string; message?: string; stage?: string }>(
			'diarization-progress',
			(e) => {
				const meetingId = e.payload?.meeting_id;
				if (!meetingId) return;
				this.progress(
					'diarization',
					meetingId,
					'Identifying speakers',
					null,
					e.payload.message ?? e.payload.stage ?? '',
				);
			},
		);
		void listen<{ meeting_id?: string }>('diarization-complete', (e) => {
			const meetingId = e.payload?.meeting_id;
			if (!meetingId) return;
			this.finish('diarization', meetingId, 'done', 'Speakers identified');
		});
		void listen<{ meeting_id?: string; error?: string }>('diarization-error', (e) => {
			const meetingId = e.payload?.meeting_id;
			if (!meetingId) return;
			this.finish('diarization', meetingId, 'error', e.payload?.error ?? 'Failed');
		});
	}
}

export const backgroundTasks = new BackgroundTasksStore();
