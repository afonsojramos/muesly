/**
 * usePaginatedTranscripts
 *
 * Infinite-scroll pagination over a meeting's transcripts (backed by the
 * `api_get_meeting_transcripts` command). Exposes both raw transcripts and
 * a derived `segments` view for the virtualized renderer.
 *
 * `meetingId` is provided via a getter so the hook reacts to route changes.
 */

import { invoke } from '@tauri-apps/api/core';

import type {
	MeetingMetadata,
	PaginatedTranscriptsResponse,
	Transcript,
	TranscriptSegmentData
} from '$lib/types';

const DEFAULT_PAGE_SIZE = 100;

function toSegments(transcripts: Transcript[]): TranscriptSegmentData[] {
	return transcripts.map((t) => ({
		id: t.id,
		timestamp: t.audio_start_time ?? 0,
		endTime: t.audio_end_time,
		text: t.text,
		confidence: t.confidence,
		speaker: t.speaker
	}));
}

export interface UsePaginatedTranscripts {
	readonly metadata: MeetingMetadata | null;
	readonly segments: TranscriptSegmentData[];
	readonly transcripts: Transcript[];
	readonly isLoading: boolean;
	readonly isLoadingMore: boolean;
	readonly hasMore: boolean;
	readonly totalCount: number;
	readonly loadedCount: number;
	readonly error: string | null;
	loadMore: () => Promise<void>;
	reset: () => void;
	refetch: () => Promise<void>;
}

export function usePaginatedTranscripts(getMeetingId: () => string | null): UsePaginatedTranscripts {
	let metadata = $state<MeetingMetadata | null>(null);
	let transcripts = $state<Transcript[]>([]);
	let totalCount = $state(0);
	let isLoading = $state(true);
	let isLoadingMore = $state(false);
	let hasMore = $state(false);
	let error = $state<string | null>(null);

	const segments = $derived(toSegments(transcripts));

	let offset = 0;
	let loadedMeetingId: string | null = null;
	let loadingGuard = false;
	let lastLoadTime = 0;

	const reset = (): void => {
		metadata = null;
		transcripts = [];
		totalCount = 0;
		isLoading = true;
		isLoadingMore = false;
		hasMore = false;
		error = null;
		offset = 0;
	};

	const loadMetadata = async (meetingId: string): Promise<void> => {
		try {
			metadata = await invoke<MeetingMetadata>('api_get_meeting_metadata', { meetingId });
		} catch (err) {
			console.error('Failed to load meeting metadata:', err);
			error = 'Failed to load meeting details';
		}
	};

	const loadAtOffset = async (
		meetingId: string,
		at: number,
		append: boolean
	): Promise<void> => {
		try {
			const response = await invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', {
				meetingId,
				limit: DEFAULT_PAGE_SIZE,
				offset: at
			});
			const incoming = response.transcripts;

			if (append) {
				const existing = new Set(transcripts.map((t) => t.id));
				const uniqueNew = incoming.filter((t) => !existing.has(t.id));
				transcripts = [...transcripts, ...uniqueNew].sort(
					(a, b) => (a.audio_start_time ?? 0) - (b.audio_start_time ?? 0)
				);
			} else {
				transcripts = incoming;
			}

			hasMore = response.has_more;
			totalCount = response.total_count;
			offset = at + incoming.length;
		} catch (err) {
			console.error('Failed to load transcripts:', err);
			error = 'Failed to load transcripts';
		}
	};

	const loadMore = async (): Promise<void> => {
		const now = Date.now();
		if (now - lastLoadTime < 100) return;
		const meetingId = getMeetingId();
		if (loadingGuard || !hasMore || !meetingId || isLoading) return;

		lastLoadTime = now;
		loadingGuard = true;
		isLoadingMore = true;
		try {
			await loadAtOffset(meetingId, offset, true);
		} finally {
			isLoadingMore = false;
			loadingGuard = false;
		}
	};

	const refetch = async (): Promise<void> => {
		const meetingId = getMeetingId();
		if (!meetingId) return;
		reset();
		isLoading = true;
		try {
			await loadMetadata(meetingId);
			await loadAtOffset(meetingId, 0, false);
		} finally {
			isLoading = false;
		}
	};

	// Initial load, reacting to meetingId changes.
	$effect(() => {
		const meetingId = getMeetingId();
		if (!meetingId) {
			reset();
			loadedMeetingId = null;
			return;
		}
		if (loadedMeetingId === meetingId) return;
		loadedMeetingId = meetingId;

		reset();
		isLoading = true;
		(async () => {
			try {
				await loadMetadata(meetingId);
				await loadAtOffset(meetingId, 0, false);
			} finally {
				isLoading = false;
			}
		})();
	});

	return {
		get metadata() {
			return metadata;
		},
		get segments() {
			return segments;
		},
		get transcripts() {
			return transcripts;
		},
		get isLoading() {
			return isLoading;
		},
		get isLoadingMore() {
			return isLoadingMore;
		},
		get hasMore() {
			return hasMore;
		},
		get totalCount() {
			return totalCount;
		},
		get loadedCount() {
			return transcripts.length;
		},
		get error() {
			return error;
		},
		loadMore,
		reset,
		refetch
	};
}
