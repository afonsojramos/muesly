<script lang="ts">
	import { emit } from '@tauri-apps/api/event';
	import { LoaderCircle, Pause, Play, Square } from '@lucide/svelte';

	import { recordingState } from '$lib/stores/recording-state.svelte';
	import AudioLinesIndicator from '$lib/components/AudioLinesIndicator.svelte';
	import { cn } from '$lib/utils';

	interface Props {
		showAudioIndicator?: boolean;
		showControls?: boolean;
		showElapsed?: boolean;
	}

	let { showAudioIndicator = true, showControls = true, showElapsed = true }: Props = $props();

	// In-app recording control, shown at the bottom of the main window while the
	// app is focused (the floating pill covers the backgrounded case). Mirrors the
	// pill's controls and stop path, laid out horizontally.

	const isPaused = $derived(recordingState.isPaused);

	const displaySeconds = $derived(
		recordingState.activeDuration !== null ? Math.floor(recordingState.activeDuration) : 0,
	);
	function formatDuration(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}
	const elapsed = $derived(formatDuration(displaySeconds));

	// Re-entrancy guards so a double tap can't fire two stop/pause calls; the
	// shared store methods are idempotent regardless.
	let isStopping = $state(false);
	let isPausing = $state(false);
	let isResuming = $state(false);
	const stopRequested = $derived(isStopping || recordingState.isStopping);

	async function handleStop(): Promise<void> {
		if (isStopping) return;
		isStopping = true;
		try {
			const stopped = await recordingState.stop();
			// Same completion path as the floating pill and the tray: the (app)
			// layout's recording-stop-complete listener runs the flush → SQLite save
			// → navigation pipeline.
			if (stopped) await emit('recording-stop-complete', true);
		} finally {
			isStopping = false;
		}
	}

	async function handleTogglePause(): Promise<void> {
		if (isPaused) {
			if (isResuming) return;
			isResuming = true;
			try {
				await recordingState.resume();
			} finally {
				isResuming = false;
			}
		} else {
			if (isPausing) return;
			isPausing = true;
			try {
				await recordingState.pause();
			} finally {
				isPausing = false;
			}
		}
	}
</script>

<div
	class="flex items-center gap-2.5 rounded-full border border-border bg-card py-1.5 pl-3 pr-3.5 shadow-[0_2px_12px_rgb(0,0,0,0.1)]"
>
	{#if showAudioIndicator}
		<AudioLinesIndicator
			active={!isPaused && !stopRequested}
			class={cn('size-4', isPaused ? 'text-muted-foreground/60' : 'text-brand')}
		/>
	{/if}

	{#if showControls && !stopRequested}<button
			onclick={handleTogglePause}
			disabled={isPausing || isResuming || isStopping}
			aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
			class="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-60"
		>
			{#if isPaused}<Play size={15} />{:else}<Pause size={15} />{/if}
		</button>

		<button
			onclick={handleStop}
			disabled={isStopping || isPausing || isResuming}
			aria-label="Stop recording"
			class="flex size-8 items-center justify-center rounded-full bg-destructive text-white transition-opacity hover:opacity-90 disabled:opacity-50"
		>
			<Square size={15} />
		</button>{:else if stopRequested}
		<LoaderCircle
			class="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
			aria-hidden="true"
		/>
	{/if}

	{#if showElapsed && !stopRequested}<span
			class="min-w-[3ch] text-xs tabular-nums text-muted-foreground"
			aria-live="polite"
		>
			{elapsed}
		</span>{/if}

	{#if isPaused}
		<span class="text-xs font-medium text-muted-foreground">Paused</span>
	{:else if stopRequested}<span class="text-xs font-medium text-muted-foreground">Saving…</span
		>{/if}
</div>
