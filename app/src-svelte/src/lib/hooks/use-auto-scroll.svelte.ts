/**
 * useAutoScroll
 *
 * Auto-scrolls a transcript container to the bottom when new segments arrive
 * during recording, while respecting manual scroll-up (pauses auto-scroll
 * until the user returns to the bottom). Can be fully disabled for the
 * meeting-details (read-only) view.
 *
 * The React version coordinated with a `@tanstack/react-virtual` virtualizer;
 * the Svelte transcript view renders natively, so this operates purely on the
 * scroll element. Reactive inputs are supplied via getters.
 */

import { onMount } from 'svelte';

import type { TranscriptSegmentData } from '$lib/types';

const SCROLL_THRESHOLD = 100;

export interface UseAutoScrollOptions {
	getScrollElement: () => HTMLElement | null;
	getSegments: () => TranscriptSegmentData[];
	getIsRecording: () => boolean;
	getIsPaused: () => boolean;
	getActiveSegmentId?: () => string | undefined;
	disableAutoScroll?: boolean;
}

export interface UseAutoScroll {
	readonly autoScroll: boolean;
	setAutoScroll: (value: boolean) => void;
	scrollToBottom: () => void;
}

export function useAutoScroll(options: UseAutoScrollOptions): UseAutoScroll {
	const {
		getScrollElement,
		getSegments,
		getIsRecording,
		getIsPaused,
		getActiveSegmentId,
		disableAutoScroll = false
	} = options;

	let autoScroll = $state(true);

	let userScrolled = false;
	let isProgrammaticScroll = false;
	let prevSegmentCount = getSegments().length;

	const isNearBottom = (): boolean => {
		const el = getScrollElement();
		if (!el) return true;
		const { scrollTop, scrollHeight, clientHeight } = el;
		return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
	};

	const scrollToBottom = (): void => {
		const el = getScrollElement();
		if (!el) return;
		isProgrammaticScroll = true;
		el.scrollTop = el.scrollHeight;
		userScrolled = false;
		autoScroll = true;
		setTimeout(() => {
			isProgrammaticScroll = false;
		}, 50);
	};

	// Detect manual scrolling (debounced).
	onMount(() => {
		const el = getScrollElement();
		if (!el) return;

		let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

		const handleScroll = (): void => {
			if (isProgrammaticScroll) return;
			// Lock immediately when the user scrolls away from the bottom, so a
			// segment arriving mid-scroll can't yank them back down.
			if (!isNearBottom()) {
				if (scrollTimeout) {
					clearTimeout(scrollTimeout);
					scrollTimeout = null;
				}
				userScrolled = true;
				autoScroll = false;
				return;
			}
			// Re-engage once they settle back at the bottom (debounced so momentum
			// scrolling doesn't flip the lock repeatedly).
			if (scrollTimeout) clearTimeout(scrollTimeout);
			scrollTimeout = setTimeout(() => {
				if (isNearBottom()) {
					userScrolled = false;
					autoScroll = true;
				}
			}, 100);
		};

		el.addEventListener('scroll', handleScroll, { passive: true });
		return () => {
			el.removeEventListener('scroll', handleScroll);
			if (scrollTimeout) clearTimeout(scrollTimeout);
		};
	});

	// Auto-scroll on new segments during recording.
	$effect(() => {
		const segments = getSegments();
		const isRecording = getIsRecording();
		const isPaused = getIsPaused();

		if (disableAutoScroll) {
			prevSegmentCount = segments.length;
			return;
		}

		const segmentCount = segments.length;
		const hasNew = segmentCount > prevSegmentCount;
		prevSegmentCount = segmentCount;

		// Follow while engaged. `userScrolled` (set the moment the user scrolls up)
		// is the lock; no post-render position check here, so a tall new segment
		// can't bail out of following.
		if (hasNew && autoScroll && !userScrolled && isRecording && !isPaused && segmentCount > 0) {
			isProgrammaticScroll = true;
			const el = getScrollElement();
			if (el) el.scrollTop = el.scrollHeight;
			setTimeout(() => {
				isProgrammaticScroll = false;
			}, 150);
		}
	});

	// Scroll to an active segment (e.g. from search results).
	$effect(() => {
		const activeSegmentId = getActiveSegmentId?.();
		if (!activeSegmentId) return;
		isProgrammaticScroll = true;
		const element = document.getElementById(`segment-${activeSegmentId}`);
		if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
		setTimeout(() => {
			isProgrammaticScroll = false;
		}, 500);
	});

	return {
		get autoScroll() {
			return autoScroll;
		},
		setAutoScroll: (value: boolean) => {
			autoScroll = value;
		},
		scrollToBottom
	};
}
