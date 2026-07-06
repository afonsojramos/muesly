<script lang="ts">
	import { onMount } from 'svelte';
	import { emit } from '@tauri-apps/api/event';
	import { cubicOut } from 'svelte/easing';
	import type { TransitionConfig } from 'svelte/transition';
	import { Pause, Play, Square } from '@lucide/svelte';

	import { recordingState } from '$lib/stores/recording-state.svelte';
	import { cn } from '$lib/utils';

	const isPaused = $derived(recordingState.isPaused);

	// Elapsed time mirrors the in-app status bar: backend-reported active duration,
	// floored to whole seconds, formatted mm:ss.
	const displaySeconds = $derived(
		recordingState.activeDuration !== null ? Math.floor(recordingState.activeDuration) : 0,
	);

	function formatDuration(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}

	const elapsed = $derived(formatDuration(displaySeconds));

	// Honour prefers-reduced-motion: static bars + a steady "Recording" cue instead of
	// the random level animation, and a plain opacity fade for enter/exit.
	let reducedMotion = $state(false);

	// Enter/exit: a gentle rise + fade normally, reduced to a short opacity-only fade
	// when the user prefers reduced motion. Reads reducedMotion at call time so it is
	// always correct, even for the first paint.
	function pillTransition(_node: Element): TransitionConfig {
		if (reducedMotion) {
			return { duration: 120, css: (t) => `opacity: ${t}` };
		}
		return {
			duration: 200,
			easing: cubicOut,
			css: (t, u) => `opacity: ${t}; transform: translateY(${u * 12}px)`,
		};
	}

	// Decorative level bars: three vertical bars in a row (a level-meter look) whose
	// heights animate from the same Math.random() loop the in-app pill used. Under
	// reduced motion they stay at a steady mid height.
	let barHeights = $state<string[]>(['10px', '18px', '10px']);

	// Re-entrancy guards so a double tap (or a global-shortcut + click race) can't
	// fire two stop/pause calls; the shared store methods are also idempotent.
	let isStopping = $state(false);
	let isPausing = $state(false);
	let isResuming = $state(false);

	async function handleStop(): Promise<void> {
		if (isStopping) return;
		isStopping = true;
		try {
			const stopped = await recordingState.stop();
			// The pill is a separate webview and cannot call the main window's
			// post-stop pipeline (transcript flush, SQLite save, navigation) directly.
			// Broadcasting recording-stop-complete drives it via the main window's
			// listener, mirroring how the tray stop signals completion. Without this
			// a recording stopped from the pill would never be saved.
			if (stopped) {
				await emit('recording-stop-complete', true);
			}
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

	onMount(() => {
		const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion = motionQuery.matches;
		const onMotionChange = (e: MediaQueryListEvent): void => {
			reducedMotion = e.matches;
		};
		motionQuery.addEventListener('change', onMotionChange);

		// The pill webview is a separate JS context that can miss the broadcast events
		// (not replayed) or be background-throttled while hidden. start() wires the
		// recording-* listeners (idempotent), and the explicit syncWithBackend() pulls
		// the authoritative state so a freshly-shown pill is correct immediately.
		let cleanupListeners: (() => void) | undefined;
		let cancelled = false;
		void recordingState.start().then((cleanup) => {
			if (cancelled) cleanup();
			else cleanupListeners = cleanup;
		});
		void recordingState.syncWithBackend();

		// Re-fetch whenever the window becomes visible again, in case throttling stalled
		// the 500ms poll while hidden.
		const onVisibility = (): void => {
			if (document.visibilityState === 'visible') {
				void recordingState.syncWithBackend();
			}
		};
		document.addEventListener('visibilitychange', onVisibility);

		// Decorative level animation. The pill webview is pre-warmed and never
		// unmounts (it is hidden, not destroyed, between recordings) and has
		// backgroundThrottling disabled, so gate the loop on an actually-visible
		// active recording instead of letting it churn reactive state forever.
		const interval = setInterval(() => {
			if (reducedMotion || !recordingState.isRecording || document.visibilityState !== 'visible')
				return;
			barHeights = [
				`${Math.random() * 14 + 6}px`,
				`${Math.random() * 14 + 6}px`,
				`${Math.random() * 14 + 6}px`,
			];
		}, 300);

		return () => {
			cancelled = true;
			clearInterval(interval);
			motionQuery.removeEventListener('change', onMotionChange);
			document.removeEventListener('visibilitychange', onVisibility);
			cleanupListeners?.();
		};
	});
</script>

<div class="relative flex h-screen w-screen items-center justify-center bg-transparent">
	<div transition:pillTransition class="relative">
		<div
			class="relative flex flex-col items-center gap-2.5 rounded-3xl border border-border bg-card px-2.5 py-3 shadow-[0_2px_10px_rgb(0,0,0,0.12)]"
		>
			<!-- Full-surface drag underlay: the whole pill drags, but the relative
			     interactive children below sit on top so their clicks win. -->
			<div
				data-tauri-drag-region
				class="absolute inset-0 rounded-3xl"
				style="-webkit-user-select:none"
			></div>

			<span class="relative text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
				{elapsed}
			</span>

			<button
				onclick={handleTogglePause}
				disabled={isPausing || isResuming || isStopping}
				aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
				class={cn(
					'relative flex size-9 items-center justify-center rounded-full border-2 transition-colors',
					isPausing || isResuming || isStopping
						? 'border-border bg-secondary text-muted-foreground'
						: 'border-border bg-card text-muted-foreground hover:bg-secondary',
				)}
			>
				{#if isPaused}<Play size={16} />{:else}<Pause size={16} />{/if}
			</button>

			<button
				onclick={handleStop}
				disabled={isStopping || isPausing || isResuming}
				aria-label="Stop recording"
				class={cn(
					'relative flex size-9 items-center justify-center rounded-full text-white transition-colors',
					isStopping || isPausing || isResuming
						? 'bg-muted-foreground/50'
						: 'bg-destructive hover:opacity-90',
				)}
			>
				<Square size={16} />
			</button>

			<div class="relative flex h-5 items-center justify-center gap-1" aria-hidden="true">
				{#each barHeights as height, index (index)}
					<div
						class={cn(
							'w-1 rounded-full transition-all duration-200',
							isPaused ? 'bg-muted-foreground/60' : 'bg-accent',
						)}
						style={`height: ${isPaused || reducedMotion ? '8px' : height}; opacity: ${isPaused ? 0.6 : 1};`}
					></div>
				{/each}
			</div>

			{#if reducedMotion}
				<span class="relative text-[10px] text-muted-foreground">
					{isPaused ? 'Paused' : 'Recording'}
				</span>
			{/if}
		</div>
	</div>
</div>
