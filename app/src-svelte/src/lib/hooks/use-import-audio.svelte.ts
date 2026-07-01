/**
 * useImportAudio
 *
 * Drives the audio-import workflow: native file selection, drag-drop
 * validation, import start/cancel, and progress/completion/error events from
 * the Tauri backend. Mirrors the React useImportAudio hook.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { onMount } from 'svelte';

import { Analytics } from '$lib/analytics';

export interface AudioFileInfo {
	path: string;
	filename: string;
	duration_seconds: number;
	size_bytes: number;
	format: string;
}

export interface ImportProgress {
	stage: string;
	progress_percentage: number;
	message: string;
}

export interface ImportResult {
	meeting_id: string;
	title: string;
	segments_count: number;
	duration_seconds: number;
}

export interface ImportError {
	error: string;
}

export type ImportStatus = 'idle' | 'validating' | 'processing' | 'complete' | 'error';

export interface UseImportAudioOptions {
	onComplete?: (result: ImportResult) => void;
	onError?: (error: string) => void;
}

export interface UseImportAudio {
	readonly status: ImportStatus;
	readonly fileInfo: AudioFileInfo | null;
	readonly progress: ImportProgress | null;
	readonly error: string | null;
	readonly isProcessing: boolean;
	readonly isBusy: boolean;
	selectFile: () => Promise<AudioFileInfo | null>;
	validateFile: (path: string) => Promise<AudioFileInfo | null>;
	startImport: (
		sourcePath: string,
		title: string,
		language?: string | null,
		model?: string | null,
		provider?: string | null,
	) => Promise<void>;
	cancelImport: () => Promise<void>;
	reset: () => void;
}

function errorMessage(err: unknown, fallback: string): string {
	if (typeof err === 'string') return err;
	if (err instanceof Error) return err.message;
	return fallback;
}

export function useImportAudio(options: UseImportAudioOptions = {}): UseImportAudio {
	let status = $state<ImportStatus>('idle');
	let fileInfo = $state<AudioFileInfo | null>(null);
	let progress = $state<ImportProgress | null>(null);
	let error = $state<string | null>(null);

	// Prevents late events from updating state after a cancel.
	let isCancelled = false;

	onMount(() => {
		const unsubscribers: UnlistenFn[] = [];
		let cancelled = false;

		(async () => {
			try {
				const unlistenProgress = await listen<ImportProgress>('import-progress', (event) => {
					if (isCancelled) return;
					progress = event.payload;
					status = 'processing';
				});
				if (cancelled) unlistenProgress();
				else unsubscribers.push(unlistenProgress);

				const unlistenComplete = await listen<ImportResult>('import-complete', async (event) => {
					if (isCancelled) return;
					await Analytics.track('import_audio_completed', {
						success: 'true',
						duration_seconds: event.payload.duration_seconds.toString(),
						segments_count: event.payload.segments_count.toString(),
					});
					status = 'complete';
					progress = null;
					options.onComplete?.(event.payload);
				});
				if (cancelled) unlistenComplete();
				else unsubscribers.push(unlistenComplete);

				const unlistenError = await listen<ImportError>('import-error', async (event) => {
					if (isCancelled) return;
					await Analytics.trackError('import_audio_failed', event.payload.error);
					status = 'error';
					error = event.payload.error;
					options.onError?.(event.payload.error);
				});
				if (cancelled) unlistenError();
				else unsubscribers.push(unlistenError);
			} catch (err) {
				console.error('[useImportAudio] Failed to set up listeners:', err);
			}
		})();

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
		};
	});

	const selectFile = async (): Promise<AudioFileInfo | null> => {
		status = 'validating';
		error = null;
		try {
			const result = await invoke<AudioFileInfo | null>('select_and_validate_audio_command');
			if (result) {
				fileInfo = result;
				status = 'idle';
				return result;
			}
			status = 'idle';
			return null;
		} catch (err) {
			status = 'error';
			const msg = errorMessage(err, 'Failed to validate file');
			error = msg;
			options.onError?.(msg);
			return null;
		}
	};

	const validateFile = async (path: string): Promise<AudioFileInfo | null> => {
		status = 'validating';
		error = null;
		try {
			const result = await invoke<AudioFileInfo>('validate_audio_file_command', { path });
			fileInfo = result;
			status = 'idle';
			return result;
		} catch (err) {
			status = 'error';
			const msg = errorMessage(err, 'Failed to validate file');
			error = msg;
			options.onError?.(msg);
			return null;
		}
	};

	const startImport = async (
		sourcePath: string,
		title: string,
		language?: string | null,
		model?: string | null,
		provider?: string | null,
	): Promise<void> => {
		isCancelled = false;
		status = 'processing';
		error = null;
		progress = null;

		try {
			if (fileInfo) {
				await Analytics.track('import_audio_started', {
					file_size_bytes: fileInfo.size_bytes.toString(),
					duration_seconds: fileInfo.duration_seconds.toString(),
					language: language || 'auto',
					model_provider: provider || '',
					model_name: model || '',
				});
			}

			await invoke('start_import_audio_command', {
				sourcePath,
				title,
				language: language || null,
				model: model || null,
				provider: provider || null,
			});
		} catch (err) {
			status = 'error';
			const msg = errorMessage(err, 'Failed to start import');
			error = msg;
			await Analytics.trackError('import_audio_failed', msg);
			options.onError?.(msg);
		}
	};

	const cancelImport = async (): Promise<void> => {
		isCancelled = true;
		try {
			await invoke('cancel_import_command');
			status = 'idle';
			progress = null;
		} catch (err) {
			console.error('Failed to cancel import:', err);
		}
	};

	const reset = (): void => {
		isCancelled = false;
		status = 'idle';
		fileInfo = null;
		progress = null;
		error = null;
	};

	return {
		get status() {
			return status;
		},
		get fileInfo() {
			return fileInfo;
		},
		get progress() {
			return progress;
		},
		get error() {
			return error;
		},
		get isProcessing() {
			return status === 'processing';
		},
		get isBusy() {
			return status === 'processing' || status === 'validating';
		},
		selectFile,
		validateFile,
		startImport,
		cancelImport,
		reset,
	};
}
