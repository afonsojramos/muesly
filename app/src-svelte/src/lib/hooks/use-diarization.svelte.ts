/**
 * useDiarization
 *
 * Headless speaker-identification flow for a meeting: model readiness and
 * download (progress via toasts), the assigned-names confirmation gate, and
 * the diarization run itself. Extracted from the old DiarizationControl
 * button so any surface (currently the meeting actions menu) can drive it;
 * the caller renders the confirmation dialog bound to `confirmOpen`.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { commands } from '$lib/bindings';
import { toast } from '$lib/toast';

export interface UseDiarization {
	/** True while downloading models or diarizing; callers disable their trigger. */
	readonly busy: boolean;
	/** Re-running clears assigned speaker names, so it needs an explicit confirm. */
	confirmOpen: boolean;
	/** Entry point: ensures models, then runs (or asks to confirm) identification. */
	identifySpeakers: () => Promise<void>;
	/** The confirmed run, called by the caller's confirmation dialog. */
	runDiarization: () => Promise<void>;
}

export function useDiarization(
	getMeetingId: () => string | undefined,
	onComplete?: () => void | Promise<void>,
): UseDiarization {
	let downloading = $state(false);
	let diarizing = $state(false);
	let confirmOpen = $state(false);

	async function downloadModels(): Promise<boolean> {
		if (downloading) return false;
		downloading = true;
		const unlisteners: UnlistenFn[] = [];
		// A persistent spinner toast tracks the ~35 MB download; the menu item that
		// triggered it has already closed, so this is the only visible feedback.
		const toastId = toast.loading('Downloading speaker models…', { description: 'About 35 MB' });
		let progress = 0;
		try {
			unlisteners.push(
				await listen<{ progress?: number }>('diarization-model-download-progress', (e) => {
					if (typeof e.payload?.progress === 'number') {
						progress = Math.round(e.payload.progress);
						toast.loading('Downloading speaker models…', {
							id: toastId,
							description: `${progress}% of ~35 MB`,
						});
					}
				}),
			);
			const res = await commands.downloadDiarizationModels();
			if (res.status === 'error') throw new Error(res.error);
			return true;
		} catch (err) {
			toast.error('Speaker model download failed', {
				description:
					err instanceof Error ? `${err.message} (at ${progress}%)` : `Failed at ${progress}%`,
			});
			return false;
		} finally {
			toast.dismiss(toastId);
			unlisteners.forEach((u) => u());
			downloading = false;
		}
	}

	async function runDiarization(): Promise<void> {
		const meetingId = getMeetingId();
		if (diarizing || !meetingId) return;
		diarizing = true;
		try {
			const res = await commands.diarizeMeeting(meetingId);
			if (res.status === 'error') throw new Error(res.error);
			toast.info(`Identified speakers on ${res.data} segment${res.data === 1 ? '' : 's'}`, {
				duration: 3000,
			});
			await onComplete?.();
		} catch (err) {
			toast.error('Speaker identification failed', {
				description: err instanceof Error ? err.message : 'Unknown error',
			});
		} finally {
			diarizing = false;
		}
	}

	async function identifySpeakers(): Promise<void> {
		const meetingId = getMeetingId();
		if (downloading || diarizing || !meetingId) return;

		// Models download lazily on first use (one action, progress via toasts).
		const readyRes = await commands.diarizationModelsReady();
		const ready = readyRes.status === 'ok' ? readyRes.data : false;
		if (!ready && !(await downloadModels())) return;

		// Re-diarization clears assigned names (cluster numbering isn't stable
		// across runs), so when names exist the run needs explicit confirmation.
		const speakers = await commands.getMeetingSpeakers(meetingId);
		const hasAssignedNames =
			speakers.status === 'ok' && speakers.data.speakers.some((s) => s.name != null);
		if (hasAssignedNames) {
			confirmOpen = true;
			return;
		}
		await runDiarization();
	}

	return {
		get busy() {
			return downloading || diarizing;
		},
		get confirmOpen() {
			return confirmOpen;
		},
		set confirmOpen(value: boolean) {
			confirmOpen = value;
		},
		identifySpeakers,
		runDiarization,
	};
}
