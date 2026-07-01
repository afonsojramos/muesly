/**
 * useProcessingProgress
 *
 * Tracks chunk-by-chunk transcription progress for audio import / retranscribe
 * flows, with pause/resume/cancel and localStorage-backed resume.
 *
 * Types that lived in ChunkProgressDisplay are inlined here so the hook is
 * self-contained; the display component will import them from this module.
 */

export type ChunkProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ChunkStatus {
	chunk_id: number;
	status: ChunkProcessingStatus;
	start_time?: number;
	end_time?: number;
	duration_ms?: number;
	text_preview?: string;
	error_message?: string;
}

export interface ProcessingProgress {
	total_chunks: number;
	completed_chunks: number;
	processing_chunks: number;
	failed_chunks: number;
	chunks: ChunkStatus[];
	estimated_remaining_ms?: number;
}

export interface ProcessingSession {
	session_id: string;
	total_audio_duration_ms: number;
	chunk_duration_ms: number;
	start_time: number;
	is_paused: boolean;
	model_name: string;
}

const emptyProgress = (): ProcessingProgress => ({
	total_chunks: 0,
	completed_chunks: 0,
	processing_chunks: 0,
	failed_chunks: 0,
	chunks: [],
});

export interface UseProcessingProgress {
	readonly progress: ProcessingProgress;
	readonly session: ProcessingSession | null;
	readonly isActive: boolean;
	readonly isComplete: boolean;
	readonly hasFailures: boolean;
	readonly isPaused: boolean;
	initializeSession: (
		totalAudioDurationMs: number,
		chunkDurationMs?: number,
		modelName?: string,
	) => void;
	startChunkProcessing: (chunkId: number) => void;
	completeChunk: (chunkId: number, transcribedText: string) => void;
	failChunk: (chunkId: number, errorMessage: string) => void;
	pauseProcessing: () => void;
	resumeProcessing: () => void;
	cancelProcessing: () => void;
	reset: () => void;
	saveProgressState: () => void;
	loadProgressState: () => boolean;
	clearSavedState: () => void;
}

export function useProcessingProgress(): UseProcessingProgress {
	let progress = $state<ProcessingProgress>(emptyProgress());
	let session = $state<ProcessingSession | null>(null);
	let isActive = $state(false);

	const processingTimes: Record<number, number> = {};

	const isComplete = $derived(
		progress.total_chunks > 0 && progress.completed_chunks === progress.total_chunks,
	);
	const hasFailures = $derived(progress.failed_chunks > 0);

	const initializeSession = (
		totalAudioDurationMs: number,
		chunkDurationMs = 30000,
		modelName = 'unknown',
	): void => {
		const totalChunks = Math.ceil(totalAudioDurationMs / chunkDurationMs);
		session = {
			session_id: `session_${Date.now()}`,
			total_audio_duration_ms: totalAudioDurationMs,
			chunk_duration_ms: chunkDurationMs,
			start_time: Date.now(),
			is_paused: false,
			model_name: modelName,
		};
		progress = {
			total_chunks: totalChunks,
			completed_chunks: 0,
			processing_chunks: 0,
			failed_chunks: 0,
			chunks: Array.from({ length: totalChunks }, (_, i) => ({
				chunk_id: i,
				status: 'pending' as const,
			})),
		};
		isActive = true;
	};

	const startChunkProcessing = (chunkId: number): void => {
		processingTimes[chunkId] = Date.now();
		progress = {
			...progress,
			processing_chunks: progress.processing_chunks + 1,
			chunks: progress.chunks.map((c) =>
				c.chunk_id === chunkId ? { ...c, status: 'processing', start_time: Date.now() } : c,
			),
		};
	};

	const completeChunk = (chunkId: number, transcribedText: string): void => {
		const start = processingTimes[chunkId];
		const end = Date.now();
		const duration = start ? end - start : 0;
		progress = {
			...progress,
			completed_chunks: progress.completed_chunks + 1,
			processing_chunks: Math.max(0, progress.processing_chunks - 1),
			chunks: progress.chunks.map((c) =>
				c.chunk_id === chunkId
					? {
							...c,
							status: 'completed',
							end_time: end,
							duration_ms: duration,
							text_preview: transcribedText.slice(0, 100),
						}
					: c,
			),
		};
		delete processingTimes[chunkId];
		updateEstimate();
	};

	const failChunk = (chunkId: number, errorMessage: string): void => {
		progress = {
			...progress,
			failed_chunks: progress.failed_chunks + 1,
			processing_chunks: Math.max(0, progress.processing_chunks - 1),
			chunks: progress.chunks.map((c) =>
				c.chunk_id === chunkId
					? { ...c, status: 'failed', error_message: errorMessage, end_time: Date.now() }
					: c,
			),
		};
		delete processingTimes[chunkId];
	};

	const updateEstimate = (): void => {
		if (!session || progress.completed_chunks === 0) return;
		const elapsed = Date.now() - session.start_time;
		const avgPerChunk = elapsed / progress.completed_chunks;
		const remaining = progress.total_chunks - progress.completed_chunks;
		progress = { ...progress, estimated_remaining_ms: remaining * avgPerChunk };
	};

	const pauseProcessing = (): void => {
		if (session) session = { ...session, is_paused: true };
	};
	const resumeProcessing = (): void => {
		if (session) session = { ...session, is_paused: false };
	};

	const reset = (): void => {
		isActive = false;
		session = null;
		progress = emptyProgress();
		for (const key of Object.keys(processingTimes)) delete processingTimes[Number(key)];
	};

	const cancelProcessing = reset;

	const saveProgressState = (): void => {
		if (!session) return;
		localStorage.setItem(
			'transcription_progress',
			JSON.stringify({ session, progress, processing_times: processingTimes, is_active: isActive }),
		);
	};

	const loadProgressState = (): boolean => {
		try {
			const saved = localStorage.getItem('transcription_progress');
			if (!saved) return false;
			const state = JSON.parse(saved);
			session = state.session;
			progress = state.progress;
			isActive = state.is_active;
			Object.assign(processingTimes, state.processing_times ?? {});
			return true;
		} catch (error) {
			console.error('Failed to load progress state:', error);
			return false;
		}
	};

	const clearSavedState = (): void => {
		localStorage.removeItem('transcription_progress');
	};

	return {
		get progress() {
			return progress;
		},
		get session() {
			return session;
		},
		get isActive() {
			return isActive;
		},
		get isComplete() {
			return isComplete;
		},
		get hasFailures() {
			return hasFailures;
		},
		get isPaused() {
			return session?.is_paused ?? false;
		},
		initializeSession,
		startChunkProcessing,
		completeChunk,
		failChunk,
		pauseProcessing,
		resumeProcessing,
		cancelProcessing,
		reset,
		saveProgressState,
		loadProgressState,
		clearSavedState,
	};
}
