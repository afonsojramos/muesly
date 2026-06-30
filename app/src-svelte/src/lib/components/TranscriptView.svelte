<script lang="ts" module>
	// Helper: format seconds as recording-relative time [MM:SS].
	function formatRecordingTime(seconds: number | undefined): string {
		if (seconds === undefined) return '[--:--]';
		const total = Math.floor(seconds);
		const minutes = Math.floor(total / 60);
		const secs = total % 60;
		return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
	}

	// Remove consecutive word repetitions (aggressive for short words).
	function cleanRepetitions(text: string): string {
		if (!text || text.trim().length === 0) return text;
		const words = text.split(/\s+/);
		const cleaned: string[] = [];
		let i = 0;
		while (i < words.length) {
			const current = words[i] ?? '';
			const currentLower = current.toLowerCase();
			let repeatCount = 1;
			while (i + repeatCount < words.length && words[i + repeatCount]?.toLowerCase() === currentLower) {
				repeatCount++;
			}
			if (current.length <= 2) {
				cleaned.push(current);
				i += repeatCount >= 2 ? repeatCount : 1;
			} else {
				cleaned.push(current);
				i += repeatCount >= 3 ? repeatCount : 1;
			}
		}
		return cleaned.join(' ');
	}

	const STOP_WORDS = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

	// Remove filler/stop words after collapsing repetitions.
	function cleanStopWords(text: string): string {
		let cleaned = cleanRepetitions(text);
		for (const word of STOP_WORDS) {
			const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
			cleaned = cleaned.replace(pattern, ' ');
		}
		return cleaned.replace(/\s+/g, ' ').trim();
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';

	import type { Transcript } from '$lib/types';
	import { config } from '$lib/stores/config.svelte';
	import ConfidenceIndicator from './ConfidenceIndicator.svelte';
	import RecordingStatusBar from './RecordingStatusBar.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { cn } from '$lib/utils';

	interface Props {
		transcripts: Transcript[];
		isRecording?: boolean;
		isPaused?: boolean;
		isProcessing?: boolean;
		isStopping?: boolean;
		enableStreaming?: boolean;
	}

	let {
		transcripts,
		isRecording = false,
		isPaused = false,
		isProcessing = false,
		isStopping = false,
		enableStreaming = false
	}: Props = $props();

	const showConfidence = $derived(config.showConfidenceIndicator);

	interface StreamingTranscript {
		id: string;
		visibleText: string;
		fullText: string;
	}

	let streamingTranscript = $state<StreamingTranscript | null>(null);
	let streamingInterval: ReturnType<typeof setInterval> | null = null;
	let lastStreamedId: string | null = null;

	function clearStreaming(): void {
		if (streamingInterval !== null) {
			clearInterval(streamingInterval);
			streamingInterval = null;
		}
	}

	// Streaming typewriter effect for the latest transcript.
	$effect(() => {
		if (!enableStreaming || !isRecording) {
			clearStreaming();
			streamingTranscript = null;
			lastStreamedId = null;
			return;
		}

		const latest = transcripts[transcripts.length - 1];
		if (!latest || lastStreamedId === latest.id) return;

		clearStreaming();
		lastStreamedId = latest.id;

		const fullText = latest.text;
		const TOTAL_DURATION_MS = 800;
		const INTERVAL_MS = 15;
		const totalTicks = TOTAL_DURATION_MS / INTERVAL_MS;
		const charsPerTick = Math.max(2, Math.ceil(fullText.length / totalTicks));
		const initialChars = Math.min(5, fullText.length);
		let charIndex = initialChars;

		streamingTranscript = {
			id: latest.id,
			visibleText: fullText.substring(0, initialChars),
			fullText
		};

		streamingInterval = setInterval(() => {
			charIndex += charsPerTick;
			if (charIndex >= fullText.length) {
				clearStreaming();
				streamingTranscript = null;
			} else {
				streamingTranscript = streamingTranscript
					? { ...streamingTranscript, visibleText: fullText.substring(0, charIndex) }
					: null;
			}
		}, INTERVAL_MS);
	});

	// Listen for speech-detected events while recording (mirrors React behavior).
	onMount(() => {
		let unsubscribe: UnlistenFn | undefined;
		let cancelled = false;

		if (isRecording) {
			listen('speech-detected', () => {}).then((fn) => {
				if (cancelled) {
					fn();
				} else {
					unsubscribe = fn;
				}
			});
		}

		return () => {
			cancelled = true;
			unsubscribe?.();
			clearStreaming();
			lastStreamedId = null;
		};
	});
</script>

<div class="px-4 py-2">
	{#if isRecording}
		<div class="sticky top-4 z-10 bg-card pb-2">
			<RecordingStatusBar {isPaused} />
		</div>
	{/if}

	{#each transcripts as transcript, index (transcript.id ? `${transcript.id}-${index}` : `transcript-${index}`)}
		{@const isStreaming = streamingTranscript?.id === transcript.id}
		{@const textToShow = isStreaming && streamingTranscript ? streamingTranscript.visibleText : transcript.text}
		{@const filteredText = cleanStopWords(textToShow)}
		{@const originalWasEmpty = transcript.text.trim() === ''}
		{@const displayText = originalWasEmpty && !isStreaming ? '[Silence]' : filteredText}
		{@const sizerText =
			cleanStopWords(isStreaming && streamingTranscript ? streamingTranscript.fullText : transcript.text) ||
			(originalWasEmpty && !isStreaming ? '[Silence]' : '')}
		<div in:fly={{ y: 5, duration: 150 }} class="mb-3">
			<div class="flex items-start gap-2">
				<Tooltip.Provider delayDuration={300}>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<span
									{...props}
									class="mt-1 min-w-[50px] flex-shrink-0 text-xs tabular-nums text-muted-foreground/70"
								>
									{transcript.audio_start_time !== undefined
										? formatRecordingTime(transcript.audio_start_time)
										: transcript.timestamp}
								</span>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>
							{#if transcript.duration !== undefined}
								<span class="text-xs text-muted-foreground/70">
									{transcript.duration.toFixed(1)}s
									{#if transcript.confidence !== undefined}
										<ConfidenceIndicator confidence={transcript.confidence} showIndicator={showConfidence} />
									{/if}
								</span>
							{:else}
								<span class="text-xs">No timing data</span>
							{/if}
						</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
				<div class="flex-1">
					{#if isStreaming}
						<div class="rounded-lg border border-border bg-secondary px-3 py-2">
							<div class="relative">
								<p class="text-base leading-relaxed text-foreground" style="visibility: hidden;">
									{sizerText}
								</p>
								<p class="absolute left-0 top-0 text-base leading-relaxed text-foreground">
									{displayText}
								</p>
							</div>
						</div>
					{:else}
						<div class="relative">
							<p class="text-base leading-relaxed text-foreground" style="visibility: hidden;">
								{sizerText}
							</p>
							<p class="absolute left-0 top-0 text-base leading-relaxed text-foreground">
								{displayText}
							</p>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/each}

	{#if !isStopping && isRecording && !isPaused && !isProcessing && transcripts.length > 0}
		<div in:fade out:fade class="mt-4 flex items-center gap-2 text-muted-foreground">
			<div class="size-2 animate-pulse rounded-full bg-accent"></div>
			<span class="text-sm">Listening...</span>
		</div>
	{/if}

	{#if transcripts.length === 0}
		<div in:fade class="mt-8 text-center text-muted-foreground">
			{#if isRecording}
				<div class="mb-3 flex items-center justify-center">
					<div class={cn('size-3 rounded-full', isPaused ? 'bg-warning' : 'animate-pulse bg-accent')}></div>
				</div>
				<p class="text-sm text-muted-foreground">
					{isPaused ? 'Recording paused' : 'Listening for speech...'}
				</p>
				<p class="mt-1 text-xs text-muted-foreground/70">
					{isPaused ? 'Click resume to continue recording' : 'Speak to see live transcription'}
				</p>
			{:else}
				<p class="text-lg font-semibold">Welcome to muesly!</p>
				<p class="mt-1 text-xs">Start recording to see live transcription</p>
			{/if}
		</div>
	{/if}
</div>
