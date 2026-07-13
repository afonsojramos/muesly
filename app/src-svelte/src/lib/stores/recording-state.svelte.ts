/**
 * Recording state store.
 *
 * Single source of truth for recording lifecycle, synchronized with the Rust
 * backend via Tauri events + periodic polling while a recording is active.
 *
 * Mirrors the React RecordingStateContext.
 */

import type { UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { recordingService } from '$lib/services/recording';
import { toast } from '$lib/toast';

export enum RecordingStatus {
	IDLE = 'idle',
	STARTING = 'starting',
	RECORDING = 'recording',
	STOPPING = 'stopping',
	PROCESSING_TRANSCRIPTS = 'processing',
	SAVING = 'saving',
	COMPLETED = 'completed',
	ERROR = 'error',
}

const STOP_FLOW_STATUSES = new Set([
	RecordingStatus.STOPPING,
	RecordingStatus.PROCESSING_TRANSCRIPTS,
	RecordingStatus.SAVING,
]);

class RecordingStateStore {
	isRecording = $state(false);
	isPaused = $state(false);
	isActive = $state(false);
	recordingDuration = $state<number | null>(null);
	activeDuration = $state<number | null>(null);
	status = $state<RecordingStatus>(RecordingStatus.IDLE);
	statusMessage = $state<string | undefined>(undefined);

	// Live audio level (0..1), pushed by the backend `recording-level` event
	// (~15/s) while recording. Drives the pill and in-app bar level meters; 0 when
	// idle or silent.
	audioLevel = $state(0);

	get isStopping(): boolean {
		return this.status === RecordingStatus.STOPPING;
	}
	get isProcessing(): boolean {
		return this.status === RecordingStatus.PROCESSING_TRANSCRIPTS;
	}
	get isSaving(): boolean {
		return this.status === RecordingStatus.SAVING;
	}

	#pollingInterval: ReturnType<typeof setInterval> | null = null;
	#unsubscribers: UnlistenFn[] = [];
	#started = false;
	#stopPromise: Promise<boolean> | null = null;

	setStatus = (status: RecordingStatus, message?: string): void => {
		console.log(`[RecordingState] Status: ${this.status} → ${status}`, message || '');
		this.status = status;
		this.statusMessage = message;
	};

	/**
	 * Mark recording as started. Called optimistically by the start hook once the
	 * backend confirms success, and by the `recording-started` event listener
	 * (idempotent) so external/tray-initiated starts stay in sync.
	 */
	markStarted = (): void => {
		this.isRecording = true;
		this.isPaused = false;
		this.isActive = true;
		this.status = RecordingStatus.RECORDING;
		this.#startPolling();
	};

	/**
	 * Drive the state machine out of the active state. Used by the `recording-error`
	 * path so a failed recording cannot leave the surfaces stuck "recording".
	 */
	markStopped = (): void => {
		this.isRecording = false;
		this.isPaused = false;
		this.isActive = false;
		this.recordingDuration = null;
		this.activeDuration = null;
		this.audioLevel = 0;
		this.#stopPolling();
		this.status = RecordingStatus.IDLE;
		this.statusMessage = undefined;
	};

	/**
	 * Stop the active recording. Shared by the in-app pill and the floating pill so
	 * the two surfaces cannot drift. Saves to `appDataDir()` + an ISO-timestamp path,
	 * and idempotently swallows the "No recording in progress" race (a second stop
	 * from another surface or the tray returns Ok(()) on the Rust side, so the guard
	 * string is brittle but matches the backend contract).
	 *
	 * @returns `true` if the stop call succeeded and a session was stopped,
	 *          `false` if it failed for any reason other than idempotency.
	 */
	async stop(): Promise<boolean> {
		if (this.#stopPromise) return this.#stopPromise;

		const previous = {
			isRecording: this.isRecording,
			isPaused: this.isPaused,
			isActive: this.isActive,
			status: this.status,
			statusMessage: this.statusMessage,
			audioLevel: this.audioLevel,
		};

		// Acknowledge the click immediately. Rust still performs the full, safe
		// transcript/audio flush; this only stops presenting the session as active.
		this.status = RecordingStatus.STOPPING;
		this.statusMessage = 'Saving meeting…';
		this.isPaused = false;
		this.isActive = false;
		this.audioLevel = 0;
		this.#stopPolling();

		this.#stopPromise = (async () => {
			try {
				const dataDir = await appDataDir();
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
				const savePath = `${dataDir}/recording-${timestamp}.wav`;
				await invoke('stop_recording', { args: { save_path: savePath } });
				return true;
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: typeof error === 'string'
							? error
							: String(error);
				if (message.includes('No recording in progress')) {
					// Already stopped by another surface — treat as a no-op success.
					return true;
				}
				// Backend may still have emitted recording-stopped and best-effort
				// saved; never block the SQLite save pipeline on a soft stream error.
				if (
					message.includes('recording data was still saved') ||
					message.includes('stream error after best-effort')
				) {
					console.warn(
						'[RecordingStateStore] Stop reported a soft stream error; continuing save pipeline:',
						message,
					);
					return true;
				}
				console.error('[RecordingStateStore] Failed to stop recording:', error);
				// A hard rejection means the backend may still be recording. Restore the
				// interactive state so the user can retry instead of leaving a false stop.
				this.isRecording = previous.isRecording;
				this.isPaused = previous.isPaused;
				this.isActive = previous.isActive;
				this.status = previous.status;
				this.statusMessage = previous.statusMessage;
				this.audioLevel = previous.audioLevel;
				if (previous.isRecording) this.#startPolling();
				toast.error('Failed to stop recording', { description: message });
				return false;
			}
		})().finally(() => {
			this.#stopPromise = null;
		});

		return this.#stopPromise;
	}

	/** Pause the active recording (idempotent at the call site). */
	async pause(): Promise<void> {
		try {
			await invoke('pause_recording');
		} catch (error) {
			console.error('[RecordingStateStore] Failed to pause recording:', error);
			toast.error('Failed to pause recording');
		}
	}

	/** Resume the paused recording (idempotent at the call site). */
	async resume(): Promise<void> {
		try {
			await invoke('resume_recording');
		} catch (error) {
			console.error('[RecordingStateStore] Failed to resume recording:', error);
			toast.error('Failed to resume recording');
		}
	}

	/** Wire up listeners and do the initial backend sync. Returns a cleanup function. */
	async start(): Promise<() => void> {
		if (this.#started) {
			return () => this.#cleanup();
		}
		this.#started = true;

		// Initial sync — fixes "backend recording but UI shows stopped" after refresh.
		await this.#syncWithBackend();

		try {
			this.#unsubscribers.push(
				await recordingService.onRecordingStarted(() => {
					this.markStarted();
				}),
				await recordingService.onRecordingStopped(() => {
					if (!STOP_FLOW_STATUSES.has(this.status)) {
						this.status = RecordingStatus.STOPPING;
						this.statusMessage = 'Stopping recording...';
					}
					this.isRecording = false;
					this.isPaused = false;
					this.isActive = false;
					this.recordingDuration = null;
					this.activeDuration = null;
					this.audioLevel = 0;
					this.#stopPolling();
				}),
				await recordingService.onRecordingPaused(() => {
					this.isPaused = true;
					this.isActive = false;
					this.audioLevel = 0;
				}),
				await recordingService.onRecordingResumed(() => {
					this.isPaused = false;
					this.isActive = true;
				}),
				await recordingService.onAudioLevel((level) => {
					this.audioLevel = level;
				}),
			);
		} catch (error) {
			console.error('[RecordingStateStore] Failed to set up event listeners:', error);
		}

		return () => this.#cleanup();
	}

	/**
	 * Public self-heal: re-fetch the authoritative recording state from the backend.
	 * The floating pill webview is a separate JS context that can miss the
	 * `recording-started` broadcast (events are not replayed) or be background-
	 * throttled while hidden, so it calls this on mount and on `visibilitychange`.
	 */
	async syncWithBackend(): Promise<void> {
		await this.#syncWithBackend();
	}

	async #syncWithBackend(): Promise<void> {
		try {
			const backend = await recordingService.getRecordingState();
			this.isRecording = backend.is_recording;
			this.isPaused = backend.is_paused;
			this.isActive = backend.is_active;
			this.recordingDuration = backend.recording_duration;
			this.activeDuration = backend.active_duration;
			// Keep `status` consistent with the synced flags. A mount that missed the
			// `recording-started` event otherwise left status at IDLE while recording.
			// Never override an in-progress stop/save flow.
			if (!STOP_FLOW_STATUSES.has(this.status)) {
				this.status = backend.is_recording ? RecordingStatus.RECORDING : RecordingStatus.IDLE;
			}
		} catch (error) {
			console.error('[RecordingStateStore] Failed to sync with backend:', error);
		}
	}

	#startPolling(): void {
		this.#stopPolling();
		this.#pollingInterval = setInterval(() => {
			void this.#syncWithBackend();
		}, 500);
	}

	#stopPolling(): void {
		if (this.#pollingInterval !== null) {
			clearInterval(this.#pollingInterval);
			this.#pollingInterval = null;
		}
	}

	#cleanup(): void {
		this.#stopPolling();
		for (const fn of this.#unsubscribers) {
			fn();
		}
		this.#unsubscribers = [];
		this.#started = false;
	}
}

export const recordingState = new RecordingStateStore();
