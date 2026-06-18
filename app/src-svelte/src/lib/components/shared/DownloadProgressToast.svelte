<script lang="ts" module>
	// Categorize raw backend error messages for friendlier display.
	export function categorizeError(error: string): string {
		const lowerError = error.toLowerCase();

		if (
			lowerError.includes('network') ||
			lowerError.includes('connection') ||
			lowerError.includes('timeout') ||
			lowerError.includes('failed to start download')
		) {
			return 'Network error - Check your internet connection';
		}
		if (lowerError.includes('status:') || lowerError.includes('http')) {
			return 'Server error - Download temporarily unavailable';
		}
		if (
			lowerError.includes('disk') ||
			lowerError.includes('write') ||
			lowerError.includes('file')
		) {
			return 'Storage error - Check available disk space';
		}
		if (lowerError.includes('invalid') || lowerError.includes('validation')) {
			return 'File validation failed - Please retry download';
		}
		return error;
	}
</script>

<script lang="ts">
	/**
	 * DownloadProgressToast
	 *
	 * Listens for Parakeet and built-in-AI model download events and surfaces
	 * them as toasts. Mirrors the React DownloadProgressToastProvider — but
	 * because the toast abstraction renders text (not a custom progress widget),
	 * progress is shown in the toast description and only meaningful transitions
	 * fire a toast (avoiding a flood of per-percent updates).
	 *
	 * Renders nothing; it exists purely for its lifecycle side effects.
	 */
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onMount } from 'svelte';

	import { toast } from '$lib/toast';

	type DownloadStatus = 'downloading' | 'completed' | 'error' | 'cancelled';

	// Tracks the last status surfaced per model so we only toast on change.
	const lastStatus = new Map<string, DownloadStatus>();

	function notify(
		displayName: string,
		status: DownloadStatus,
		detail: string | undefined,
		key: string
	): void {
		if (lastStatus.get(key) === status && status === 'downloading') return;
		lastStatus.set(key, status);

		switch (status) {
			case 'completed':
				toast.success(displayName, { description: 'Download complete', duration: 3000 });
				break;
			case 'error':
				toast.error(displayName, {
					description: detail || 'Download failed',
					duration: 10000
				});
				break;
			case 'cancelled':
				toast.info(displayName, { description: 'Download cancelled', duration: 5000 });
				break;
			case 'downloading':
				toast.info(displayName, { description: detail || 'Downloading…', duration: 4000 });
				break;
		}
	}

	onMount(() => {
		const unsubscribers: UnlistenFn[] = [];
		let cancelled = false;

		(async () => {
			try {
				const unlistenParakeetProgress = await listen<{
					modelName: string;
					progress: number;
					downloaded_mb?: number;
					total_mb?: number;
					status?: string;
				}>('parakeet-model-download-progress', (event) => {
					const { modelName, progress, status } = event.payload;
					const display = 'Transcription Model (Parakeet)';
					if (status === 'cancelled') {
						notify(display, 'cancelled', undefined, modelName);
					} else if (status === 'completed' || progress >= 100) {
						notify(display, 'completed', undefined, modelName);
					} else {
						notify(display, 'downloading', `${Math.round(progress)}%`, modelName);
					}
				});
				if (cancelled) unlistenParakeetProgress();
				else unsubscribers.push(unlistenParakeetProgress);

				const unlistenParakeetComplete = await listen<{ modelName: string }>(
					'parakeet-model-download-complete',
					(event) => {
						notify('Transcription Model (Parakeet)', 'completed', undefined, event.payload.modelName);
					}
				);
				if (cancelled) unlistenParakeetComplete();
				else unsubscribers.push(unlistenParakeetComplete);

				const unlistenParakeetError = await listen<{ modelName: string; error: string }>(
					'parakeet-model-download-error',
					(event) => {
						notify(
							'Transcription Model (Parakeet)',
							'error',
							categorizeError(event.payload.error),
							event.payload.modelName
						);
					}
				);
				if (cancelled) unlistenParakeetError();
				else unsubscribers.push(unlistenParakeetError);

				const unlistenBuiltin = await listen<{
					model: string;
					progress: number;
					status: string;
					error?: string;
				}>('builtin-ai-download-progress', (event) => {
					const { model, progress, status, error } = event.payload;
					const display = `Summary Model (${model})`;
					if (status === 'completed' || progress >= 100) {
						notify(display, 'completed', undefined, model);
					} else if (status === 'cancelled') {
						notify(display, 'cancelled', undefined, model);
					} else if (status === 'error') {
						notify(display, 'error', categorizeError(error || 'Download failed'), model);
					} else {
						notify(display, 'downloading', `${Math.round(progress ?? 0)}%`, model);
					}
				});
				if (cancelled) unlistenBuiltin();
				else unsubscribers.push(unlistenBuiltin);
			} catch (error) {
				console.error('[DownloadProgressToast] Failed to set up listeners:', error);
			}
		})();

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
		};
	});
</script>
