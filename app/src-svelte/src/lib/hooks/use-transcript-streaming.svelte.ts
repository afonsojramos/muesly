/**
 * useTranscriptStreaming
 *
 * Typewriter / streaming character-reveal effect for newly-arrived transcript
 * segments. Used by the live transcript view during active recording.
 */

import type { TranscriptSegmentData } from '$lib/types';

const INTERVAL_MS = 15;
const DURATION_MS = 800;
const INITIAL_CHARS = 5;

interface StreamingSegment {
	id: string;
	fullText: string;
	visibleText: string;
}

export interface UseTranscriptStreaming {
	readonly streamingSegmentId: string | null;
	getDisplayText: (segment: TranscriptSegmentData) => string;
}

export function useTranscriptStreaming(
	getSegments: () => TranscriptSegmentData[],
	getIsRecording: () => boolean,
	getEnableStreaming: () => boolean,
): UseTranscriptStreaming {
	let streamingSegment = $state<StreamingSegment | null>(null);
	let lastSegmentId: string | null = null;
	let streamingInterval: ReturnType<typeof setInterval> | null = null;

	const clearStreaming = (): void => {
		if (streamingInterval !== null) {
			clearInterval(streamingInterval);
			streamingInterval = null;
		}
	};

	$effect(() => {
		const segments = getSegments();
		const isRecording = getIsRecording();
		const enableStreaming = getEnableStreaming();

		if (!isRecording || !enableStreaming || segments.length === 0) {
			clearStreaming();
			streamingSegment = null;
			lastSegmentId = null;
			return;
		}

		const latest = segments[segments.length - 1];
		if (!latest || latest.id === lastSegmentId) return;

		lastSegmentId = latest.id;
		clearStreaming();

		const fullText = latest.text;
		const initial = fullText.substring(0, Math.min(INITIAL_CHARS, fullText.length));
		streamingSegment = { id: latest.id, fullText, visibleText: initial };

		if (fullText.length <= INITIAL_CHARS) return;

		const totalTicks = Math.floor(DURATION_MS / INTERVAL_MS);
		const remaining = fullText.length - INITIAL_CHARS;
		const charsPerTick = Math.max(2, Math.ceil(remaining / totalTicks));
		let charIndex = INITIAL_CHARS;

		streamingInterval = setInterval(() => {
			charIndex += charsPerTick;
			if (charIndex >= fullText.length) {
				streamingSegment = { id: latest.id, fullText, visibleText: fullText };
				clearStreaming();
			} else {
				streamingSegment = {
					id: latest.id,
					fullText,
					visibleText: fullText.substring(0, charIndex),
				};
			}
		}, INTERVAL_MS);

		return () => clearStreaming();
	});

	return {
		get streamingSegmentId() {
			return streamingSegment?.id ?? null;
		},
		getDisplayText: (segment: TranscriptSegmentData): string => {
			if (streamingSegment && segment.id === streamingSegment.id) {
				return streamingSegment.visibleText;
			}
			return segment.text;
		},
	};
}
