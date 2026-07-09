<script lang="ts" module>
	// Helper: format seconds as recording-relative time [MM:SS].
	export function formatRecordingTime(seconds: number | undefined): string {
		if (seconds === undefined) return '[--:--]';
		const total = Math.floor(seconds);
		const minutes = Math.floor(total / 60);
		const secs = total % 60;
		return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
	}

	const STOP_WORDS = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

	// Helper: remove filler words and collapse whitespace.
	export function cleanStopWords(text: string): string {
		let cleaned = text;
		for (const word of STOP_WORDS) {
			const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
			cleaned = cleaned.replace(pattern, ' ');
		}
		return cleaned.replace(/\s+/g, ' ').trim();
	}
</script>

<script lang="ts">
	import { fade, fly } from 'svelte/transition';

	import type { TranscriptSegmentData } from '$lib/types';
	import { useAutoScroll } from '$lib/hooks/use-auto-scroll.svelte';
	import { useTranscriptStreaming } from '$lib/hooks/use-transcript-streaming.svelte';
	import {
		buildSpeakerRows,
		emptySpeakerContext,
		isAssignable,
		type SpeakerContext,
	} from '$lib/speaker-label';
	import ConfidenceIndicator from './ConfidenceIndicator.svelte';
	import RecordingStatusBar from './RecordingStatusBar.svelte';
	import SpeakerLabel from './SpeakerLabel.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { cn } from '$lib/utils';

	interface Props {
		segments: TranscriptSegmentData[];
		isRecording?: boolean;
		isPaused?: boolean;
		isProcessing?: boolean;
		isStopping?: boolean;
		enableStreaming?: boolean;
		showConfidence?: boolean;
		disableAutoScroll?: boolean;
		hasMore?: boolean;
		isLoadingMore?: boolean;
		totalCount?: number;
		loadedCount?: number;
		onLoadMore?: () => void;
		/** Render named speaker labels (meeting details); off during live recording. */
		showSpeakers?: boolean;
		/** Assigned names, self name, and attendee shortlist for the labels. */
		speakerContext?: SpeakerContext;
		/** Persist a cluster's name; when set, system labels become editable. */
		onAssignSpeaker?: (speakerId: number, name: string) => void | Promise<void>;
	}

	let {
		segments,
		isRecording = false,
		isPaused = false,
		isProcessing = false,
		isStopping = false,
		enableStreaming = false,
		showConfidence = true,
		disableAutoScroll = false,
		hasMore = false,
		isLoadingMore = false,
		totalCount = 0,
		loadedCount = 0,
		onLoadMore,
		showSpeakers = false,
		speakerContext,
		onAssignSpeaker,
	}: Props = $props();

	// Per-segment speaker labels, shown only at a speaker change (turn boundary)
	// so a run of the same speaker isn't repeated. Off entirely during recording.
	const speakerLabels = $derived(
		showSpeakers ? buildSpeakerRows(segments, speakerContext ?? emptySpeakerContext()) : [],
	);

	let scrollEl = $state<HTMLDivElement>();
	let loadMoreTrigger = $state<HTMLDivElement>();

	useAutoScroll({
		getScrollElement: () => scrollEl ?? null,
		getSegments: () => segments,
		getIsRecording: () => isRecording,
		getIsPaused: () => isPaused,
		// `disableAutoScroll` is fixed for a given mount (meeting-details vs live).
		// svelte-ignore state_referenced_locally
		disableAutoScroll,
	});

	const streaming = useTranscriptStreaming(
		() => segments,
		() => isRecording,
		() => enableStreaming,
	);

	// Infinite scroll: observe the trigger element to load more.
	$effect(() => {
		const trigger = loadMoreTrigger;
		if (
			!onLoadMore ||
			!hasMore ||
			isLoadingMore ||
			isRecording ||
			segments.length === 0 ||
			!trigger
		) {
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				const first = entries[0];
				if (first && first.isIntersecting && hasMore && !isLoadingMore) {
					onLoadMore();
				}
			},
			{ root: null, rootMargin: '100px', threshold: 0 },
		);
		observer.observe(trigger);
		return () => observer.disconnect();
	});

	// Scroll-based fallback for fast scrolling.
	$effect(() => {
		const el = scrollEl;
		if (!onLoadMore || !hasMore || isLoadingMore || isRecording || !el) return;

		let ticking = false;
		const handleScroll = (): void => {
			if (ticking || isLoadingMore || !hasMore) return;
			ticking = true;
			requestAnimationFrame(() => {
				const { scrollTop, scrollHeight, clientHeight } = el;
				const scrollBottom = scrollHeight - scrollTop - clientHeight;
				if (scrollBottom < 200 && hasMore && !isLoadingMore) {
					onLoadMore?.();
				}
				ticking = false;
			});
		};

		el.addEventListener('scroll', handleScroll, { passive: true });
		return () => el.removeEventListener('scroll', handleScroll);
	});

	function displayTextFor(segment: TranscriptSegmentData): string {
		const text = streaming.getDisplayText(segment);
		return cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);
	}
</script>

<div bind:this={scrollEl} class="flex h-full flex-col overflow-y-auto px-4 py-2">
	{#if isRecording}
		<div class="sticky top-0 z-10 bg-background pb-2">
			<RecordingStatusBar {isPaused} />
		</div>
	{/if}

	<div class={cn(isRecording && 'pt-2')}>
		{#if segments.length === 0}
			<div in:fade class="mt-8 text-center text-muted-foreground">
				{#if isRecording}
					<div class="mb-3 flex items-center justify-center">
						<div
							class={cn(
								'size-3 rounded-full',
								isPaused ? 'bg-muted-foreground/60' : 'animate-pulse bg-accent',
							)}
						></div>
					</div>
					<p class="text-sm text-muted-foreground">
						{isPaused ? 'Recording paused' : 'Listening for speech...'}
					</p>
					<p class="mt-1 text-xs text-muted-foreground/70">
						{isPaused ? 'Click resume to continue recording' : 'Speak to see live transcription'}
					</p>
				{:else}
					<p class="font-display text-3xl text-foreground/90">Welcome to muesly</p>
					<p class="mt-2 text-sm text-muted-foreground">
						Start recording to see live transcription
					</p>
				{/if}
			</div>
		{:else}
			<div class="space-y-1">
				{#each segments as segment, i (segment.id)}
					{@const isStreaming = streaming.streamingSegmentId === segment.id}
					{@const isMe = segment.speaker === 'mic'}
					{@const speaker = speakerLabels[i]}
					<div in:fly={{ y: 5, duration: 150 }} id={`segment-${segment.id}`} class="mb-3">
						<div class="flex items-start gap-2">
							<Tooltip.Provider delayDuration={300}>
								<Tooltip.Root>
									<Tooltip.Trigger>
										{#snippet child({ props })}
											<span
												{...props}
												class="mt-1 min-w-[46px] flex-shrink-0 text-[11px] tabular-nums text-muted-foreground/60"
											>
												{formatRecordingTime(segment.timestamp)}
											</span>
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content>
										{#if segment.confidence !== undefined && showConfidence}
											<ConfidenceIndicator
												confidence={segment.confidence}
												showIndicator={showConfidence}
											/>
										{:else}
											<span class="text-xs">No confidence data</span>
										{/if}
									</Tooltip.Content>
								</Tooltip.Root>
							</Tooltip.Provider>
							<div class={cn('min-w-0 flex-1', isMe && 'text-right')}>
								<!-- Speaker label at each turn boundary: the "them" side is
								     editable (assign/rename from the attendee shortlist); the
								     mic side reads "You" and is not editable. -->
								{#if speaker?.show && speaker.label}
									{#if onAssignSpeaker && isAssignable(segment)}
										<!-- Only reachable for system segments (isAssignable), which are
										     always left-aligned; the mic side uses the plain span below. -->
										<SpeakerLabel
											label={speaker.label}
											speakerId={segment.speaker_id!}
											shortlist={(speakerContext ?? emptySpeakerContext()).shortlist}
											onAssign={onAssignSpeaker}
										/>
									{:else}
										<span class="mb-0.5 block text-[11px] font-medium text-muted-foreground"
											>{speaker.label}</span
										>
									{/if}
								{/if}
								<!-- Granola-style attribution: your mic on the right (accent
								     tint), other participants on the left (gray). -->
								<div
									class={cn(
										'inline-block max-w-[88%] rounded-xl px-3 py-1.5 text-left',
										isMe ? 'bg-accent/15' : 'bg-secondary',
										isStreaming && 'ring-1 ring-accent/30',
									)}
								>
									<p
										class="text-sm leading-relaxed text-foreground break-words [overflow-wrap:anywhere]"
									>
										{displayTextFor(segment)}
									</p>
								</div>
							</div>
						</div>
					</div>
				{/each}
			</div>

			{#if (hasMore || isLoadingMore) && !isRecording && segments.length > 0}
				<div bind:this={loadMoreTrigger} class="mt-2 flex items-center justify-center py-4">
					{#if isLoadingMore}
						<div class="flex items-center gap-2 text-muted-foreground">
							<div
								class="size-4 animate-spin rounded-full border-2 border-border border-t-foreground"
							></div>
							<span class="text-sm">Loading more...</span>
						</div>
					{:else if hasMore && totalCount > 0}
						<span class="text-sm text-muted-foreground/70">
							Showing {loadedCount} of {totalCount} segments
						</span>
					{/if}
				</div>
			{/if}

			{#if !isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0}
				<div in:fade out:fade class="mt-4 flex items-center gap-2 text-muted-foreground">
					<div class="size-2 animate-pulse rounded-full bg-accent"></div>
					<span class="text-sm">Listening...</span>
				</div>
			{/if}
		{/if}
	</div>
</div>
