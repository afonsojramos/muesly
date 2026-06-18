/**
 * Ollama download progress store.
 *
 * Mirrors the React OllamaDownloadContext. Subscribes to Tauri events for
 * progress / complete / error and exposes reactive maps of in-flight downloads.
 *
 * Use SvelteMap / SvelteSet from svelte/reactivity so iteration, .has(), .get()
 * are all fine-grained reactive without rewrapping the value on every change.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { toast } from '$lib/toast';

interface ProgressPayload {
	modelName: string;
	progress: number;
}

interface CompletePayload {
	modelName: string;
}

interface ErrorPayload {
	modelName: string;
	error: string;
}

class OllamaDownloadStore {
	/** modelName -> progress (0-100). Reactive on add / update / delete. */
	readonly downloadProgress = new SvelteMap<string, number>();

	/** Set of modelNames currently downloading. Reactive on add / delete. */
	readonly downloadingModels = new SvelteSet<string>();

	#unsubscribers: UnlistenFn[] = [];
	#started = false;

	isDownloading(modelName: string): boolean {
		return this.downloadingModels.has(modelName);
	}

	getProgress(modelName: string): number | undefined {
		return this.downloadProgress.get(modelName);
	}

	/** Wire up Tauri event listeners. Idempotent; returns a cleanup function. */
	async start(): Promise<() => void> {
		if (this.#started) {
			return () => this.#cleanup();
		}
		this.#started = true;

		try {
			const unlistenProgress = await listen<ProgressPayload>(
				'ollama-model-download-progress',
				(event) => {
					const { modelName, progress } = event.payload;
					this.downloadProgress.set(modelName, progress);
					this.downloadingModels.add(modelName);
				}
			);

			const unlistenComplete = await listen<CompletePayload>(
				'ollama-model-download-complete',
				(event) => {
					const { modelName } = event.payload;
					toast.success(`Model ${modelName} downloaded!`, {
						description: 'Model is now ready to use',
						duration: 4000
					});
					this.downloadProgress.delete(modelName);
					this.downloadingModels.delete(modelName);
				}
			);

			const unlistenError = await listen<ErrorPayload>(
				'ollama-model-download-error',
				(event) => {
					const { modelName, error } = event.payload;
					toast.error(`Download failed: ${modelName}`, {
						description: error,
						duration: 6000
					});
					this.downloadProgress.delete(modelName);
					this.downloadingModels.delete(modelName);
				}
			);

			this.#unsubscribers.push(unlistenProgress, unlistenComplete, unlistenError);
		} catch (error) {
			console.error('[OllamaDownloadStore] Failed to set up event listeners:', error);
			this.#started = false;
		}

		return () => this.#cleanup();
	}

	#cleanup(): void {
		for (const fn of this.#unsubscribers) {
			fn();
		}
		this.#unsubscribers = [];
		this.#started = false;
	}
}

export const ollamaDownload = new OllamaDownloadStore();
