<script lang="ts" module>
	import { formatRecordingTimestamp } from '$lib/utils/format-time';

	// Helper: format seconds as recording-relative time [MM:SS] (or [H:MM:SS]).
	export function formatRecordingTime(seconds: number | undefined): string {
		if (seconds === undefined) return '[--:--]';
		return formatRecordingTimestamp(seconds);
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
	import { sidePanelState } from '$lib/stores/side-panel.svelte';
	import ConfidenceIndicator from './ConfidenceIndicator.svelte';
	import RecordingStatusBar from './RecordingStatusBar.svelte';
	import SpeakerLabel from './SpeakerLabel.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { cn } from '$lib/utils';
	import { shouldWindow, windowRange, type WindowRange } from '$lib/windowed-list';

	interface Props {
		segments: TranscriptSegmentData[];
		isRecording?: boolean;
		isPaused?: boolean;
		isProcessing?: boolean;
		isStopping?: boolean;
		enableStreaming?: boolean;
		showConfidence?: boolean;
		showRecordingStatus?: boolean;
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
		/** Clear a cluster's name, reverting it to "Speaker N". */
		onClearSpeaker?: (speakerId: number) => void | Promise<void>;
	}

	/** Approximate row height for windowing (variable content; overscan covers drift). */
	const EST_ROW_PX = 72;

	let {
		segments,
		isRecording = false,
		isPaused = false,
		isProcessing = false,
		isStopping = false,
		enableStreaming = false,
		showConfidence = true,
		showRecordingStatus = true,
		disableAutoScroll = false,
		hasMore = false,
		isLoadingMore = false,
		totalCount = 0,
		loadedCount = 0,
		onLoadMore,
		showSpeakers = false,
		speakerContext,
		onAssignSpeaker,
		onClearSpeaker,
	}: Props = $props();

	// Per-segment speaker labels, shown only at a speaker change (turn boundary)
	// so a run of the same speaker isn't repeated. Off entirely during recording.
	const speakerLabels = $derived(
		showSpeakers ? buildSpeakerRows(segments, speakerContext ?? emptySpeakerContext()) : [],
	);

	let scrollEl = $state<HTMLDivElement>();
	let loadMoreTrigger = $state<HTMLDivElement>();
	let win = $state<WindowRange>({ start: 0, end: 0, padTop: 0, padBottom: 0 });

	const useWindowing = $derived(shouldWindow(segments.length) && !isRecording);

	function recomputeWindow(): void {
		const el = scrollEl;
		if (!el || !useWindowing) {
			win = {
				start: 0,
				end: segments.length,
				padTop: 0,
				padBottom: 0,
			};
			return;
		}
		win = windowRange(el.scrollTop, el.clientHeight, segments.length, EST_ROW_PX, 10);
	}

	// Keep the window in sync when the segment list grows (pagination / live).
	$effect(() => {
		void segments.length;
		void isRecording;
		recomputeWindow();
	});

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

	// Jump from summary timestamp: scroll the target segment into view.
	// When windowed, expand the window around the focused index first.
	$effect(() => {
		const id = sidePanelState.focusSegmentId;
		if (!id) return;
		const idx = segments.findIndex((s) => s.id === id);
		if (idx >= 0 && useWindowing && scrollEl) {
			const targetTop = Math.max(0, idx * EST_ROW_PX - scrollEl.clientHeight / 3);
			scrollEl.scrollTop = targetTop;
			recomputeWindow();
		}
		// Defer DOM lookup a frame so the window can mount the target row.
		const frame = requestAnimationFrame(() => {
			const el = document.getElementById(`segment-${id}`);
			if (el) {
				el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		});
		const t = setTimeout(() => {
			if (sidePanelState.focusSegmentId === id) sidePanelState.focusSegmentId = null;
		}, 2500);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(t);
		};
	});

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
			{ root: scrollEl ?? null, rootMargin: '100px', threshold: 0 },
		);
		observer.observe(trigger);
		return () => observer.disconnect();
	});

	// Scroll: update window + load-more fallback.
	$effect(() => {
		const el = scrollEl;
		if (!el) return;

		let ticking = false;
		const handleScroll = (): void => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				recomputeWindow();
				if (onLoadMore && hasMore && !isLoadingMore && !isRecording) {
					const { scrollTop, scrollHeight, clientHeight } = el;
					const scrollBottom = scrollHeight - scrollTop - clientHeight;
					if (scrollBottom < 200) {
						onLoadMore();
					}
				}
				ticking = false;
			});
		};

		el.addEventListener('scroll', handleScroll, { passive: true });
		// Initial measure after layout.
		requestAnimationFrame(() => recomputeWindow());
		return () => el.removeEventListener('scroll', handleScroll);
	});

	function displayTextFor(segment: TranscriptSegmentData): string {
		const text = streaming.getDisplayText(segment);
		return cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);
	}

	const visibleStart = $derived(useWindowing ? win.start : 0);
	const visibleEnd = $derived(useWindowing ? win.end : segments.length);

	// When windowed, the row that opened the current speaker run may sit above
	// the window; surface the active speaker on the first mounted row instead.
	function speakerRowAt(i: number): { label?: string; show: boolean } | undefined {
		const row = speakerLabels[i];
		if (row && useWindowing && i === visibleStart && !row.show && row.label) {
			return { ...row, show: true };
		}
		return row;
	}
	const padTop = $derived(useWindowing ? win.padTop : 0);
	const padBottom = $derived(useWindowing ? win.padBottom : 0);
</script>

<div bind:this={scrollEl} class="flex h-full flex-col select-text overflow-y-auto px-4 py-2">
	{#if isRecording && showRecordingStatus}
		<div class="sticky top-0 z-10 bg-background pb-2">
			<RecordingStatusBar {isPaused} />
		</div>
	{/if}

	<div class={cn(isRecording && showRecordingStatus && 'pt-2')}>
		{#if segments.length === 0}
			<div in:fade class="mt-8 text-center text-muted-foreground">
				{#if isRecording}
					<div class="mb-3 flex items-center justify-center">
						<div
							class={cn(
								'size-3 rounded-full',
								isPaused ? 'bg-muted-foreground/60' : 'animate-pulse bg-brand',
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
				{#if padTop > 0}
					<div style:height="{padTop}px" aria-hidden="true"></div>
				{/if}
				{#each segments.slice(visibleStart, visibleEnd) as segment, j (segment.id)}
					{@const i = visibleStart + j}
					{@const isStreaming = streaming.streamingSegmentId === segment.id}
					{@const isMe = segment.speaker === 'mic'}
					{@const speaker = speakerRowAt(i)}
					{@const isFocused = sidePanelState.focusSegmentId === segment.id}
					<div
						in:fly={{ y: 5, duration: 150 }}
						id={`segment-${segment.id}`}
						class={cn(
							'mb-3 rounded-md transition-colors',
							isFocused && 'bg-brand/15 ring-1 ring-brand/40',
						)}
					>
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
										{#if segment.confidence != null && showConfidence}
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
											isNamed={(speakerContext ?? emptySpeakerContext()).names.has(
												segment.speaker_id!,
											)}
											onAssign={onAssignSpeaker}
											onClear={onClearSpeaker}
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
										isMe ? 'bg-brand/15' : 'bg-secondary',
										isStreaming && 'ring-1 ring-brand/30',
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
				{#if padBottom > 0}
					<div style:height="{padBottom}px" aria-hidden="true"></div>
				{/if}
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
					<div class="size-2 animate-pulse rounded-full bg-brand"></div>
					<span class="text-sm">Listening...</span>
				</div>
			{/if}
		{/if}
	</div>
</div>
