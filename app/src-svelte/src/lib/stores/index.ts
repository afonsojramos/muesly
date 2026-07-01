/**
 * Store barrel.
 *
 * Import individual stores from their own modules in component code (this gives
 * better type inference and tree-shaking). This barrel exists for the
 * `bootStores()` lifecycle helper that the root layout calls once.
 */

export { config } from './config.svelte';
export { importDialog } from './import-dialog.svelte';
export { ollamaDownload } from './ollama-download.svelte';
export { onboarding } from './onboarding.svelte';
export { recordingState, RecordingStatus } from './recording-state.svelte';
export { sidebar } from './sidebar.svelte';
export { transcripts } from './transcript.svelte';

import { config } from './config.svelte';
import { ollamaDownload } from './ollama-download.svelte';
import { onboarding } from './onboarding.svelte';
import { recordingState } from './recording-state.svelte';
import { sidebar } from './sidebar.svelte';
import { transcripts } from './transcript.svelte';

/**
 * Boot all stores. Call once from the root +layout.svelte inside `onMount`
 * (NOT a `$effect`: store start() functions read reactive state synchronously,
 * so an effect would track those reads, re-run, and tear down the singleton
 * event listeners) and return the disposer.
 */
export async function bootStores(): Promise<() => void> {
	const disposers = await Promise.all([
		config.start(),
		ollamaDownload.start(),
		onboarding.start(),
		recordingState.start(),
		sidebar.start(),
		transcripts.start(),
	]);

	return () => {
		for (const dispose of disposers) {
			dispose();
		}
	};
}
