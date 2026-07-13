/**
 * Transcript store.
 *
 * Manages the live transcript buffer, current meeting metadata, and the
 * IndexedDB recovery layer. Equivalent of the React TranscriptContext.
 *
 * DOM concerns (scroll container ref, auto-scroll behaviour) are component
 * responsibilities — the store exposes the data and components subscribe.
 */

import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';

import type { Transcript, TranscriptUpdate } from '$lib/types';
import { recordingService } from '$lib/services/recording';
import { transcriptService } from '$lib/services/transcript';
import { indexedDBService } from '$lib/services/indexed-db';
import { toast } from '$lib/toast';
import { recordingState } from './recording-state.svelte';

const SESSION_KEY = 'indexeddb_current_meeting_id';

const isBrowser = typeof window !== 'undefined';

/** Map a TranscriptUpdate source to the persisted speaker value. */
function speakerFromSource(source: string | undefined): string | undefined {
	return source === 'mic' || source === 'system' ? source : undefined;
}

function formatRecordingTime(seconds: number | undefined): string {
	if (seconds === undefined) return '[--:--]';
	const total = Math.floor(seconds);
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

class TranscriptStore {
	transcripts = $state<Transcript[]>([]);
	meetingTitle = $state<string>('+ New Call');
	currentMeetingId = $state<string | null>(null);

	#unsubscribers: UnlistenFn[] = [];
	#started = false;

	// Buffering state for the live transcript-update listener.
	#transcriptCounter = 0;
	#buffer = new Map<number, Transcript>();
	#lastProcessedSequence = 0;
	#processingTimer: ReturnType<typeof setTimeout> | null = null;
	#disposeEffectRoot: (() => void) | null = null;

	async start(): Promise<() => void> {
		if (this.#started) {
			return () => this.#cleanup();
		}
		this.#started = true;

		try {
			await indexedDBService.init();
		} catch (error) {
			console.error('[TranscriptStore] IndexedDB init failed:', error);
		}

		try {
			this.#unsubscribers.push(
				await recordingService.onRecordingStarted(async () => {
					await this.#handleRecordingStarted();
				}),
				await recordingService.onRecordingStopped(async (payload) => {
					await this.#handleRecordingStopped(payload.folder_path);
				}),
				await transcriptService.onTranscriptUpdate((update) => {
					this.#handleTranscriptUpdate(update);
				}),
			);
		} catch (error) {
			console.error('[TranscriptStore] Failed to set up listeners:', error);
		}

		// Reload-sync: if a recording is already active when this store starts
		// (e.g. webview reloaded mid-recording), pull history from the backend.
		// Capture the disposer so each start/stop cycle doesn't leak a root effect.
		this.#disposeEffectRoot = $effect.root(() => {
			$effect(() => {
				if (recordingState.isRecording && this.transcripts.length === 0) {
					void this.#syncFromBackend();
				}
			});
		});

		return () => this.#cleanup();
	}

	addTranscript = (update: TranscriptUpdate): void => {
		const newTranscript: Transcript = {
			id: update.sequence_id ? update.sequence_id.toString() : Date.now().toString(),
			text: update.text,
			timestamp: update.timestamp,
			sequence_id: update.sequence_id ?? 0,
			chunk_start_time: update.chunk_start_time,
			is_partial: update.is_partial,
			confidence: update.confidence,
			audio_start_time: update.audio_start_time,
			audio_end_time: update.audio_end_time,
			duration: update.duration,
			speaker: speakerFromSource(update.source),
		};

		const duplicate = this.transcripts.some(
			(t) => t.text === update.text && t.timestamp === update.timestamp,
		);
		if (duplicate) return;

		this.transcripts = [...this.transcripts, newTranscript].sort(
			(a, b) => (a.sequence_id ?? 0) - (b.sequence_id ?? 0),
		);
	};

	copyTranscript = (): void => {
		const text = this.transcripts
			.map((t) => `${formatRecordingTime(t.audio_start_time)} ${t.text}`)
			.join('\n');
		if (isBrowser) {
			void navigator.clipboard.writeText(text);
			toast.success('Transcript copied to clipboard');
		}
	};

	flushBuffer = (): void => {
		this.#processBuffer(true);
	};

	clearTranscripts = (): void => {
		this.transcripts = [];
		// Also reset the in-order reassembly state. A new recording's sequence ids
		// restart at 1, so leaving #lastProcessedSequence high leaves them stranded
		// behind the fast path, and a stale #buffer could leak entries across
		// recordings.
		this.#buffer.clear();
		this.#lastProcessedSequence = 0;
		this.#transcriptCounter = 0;
	};

	setMeetingTitle = (title: string): void => {
		this.meetingTitle = title;
	};

	async markMeetingAsSaved(): Promise<void> {
		const meetingId =
			this.currentMeetingId ?? (isBrowser ? sessionStorage.getItem(SESSION_KEY) : null);
		if (!meetingId) {
			console.error('[TranscriptStore] markMeetingAsSaved called without a meeting ID');
			return;
		}

		try {
			await indexedDBService.markMeetingSaved(meetingId);
			this.currentMeetingId = null;
			if (isBrowser) sessionStorage.removeItem(SESSION_KEY);
		} catch (error) {
			console.error('[TranscriptStore] Failed to mark meeting as saved:', error);
		}
	}

	async #handleRecordingStarted(): Promise<void> {
		try {
			const meetingId = `meeting-${Date.now()}`;
			this.currentMeetingId = meetingId;

			if (isBrowser) {
				sessionStorage.setItem(SESSION_KEY, meetingId);
			}

			const meetingName = await recordingService.getRecordingMeetingName();
			const fallback = `Meeting ${new Date()
				.toISOString()
				.slice(0, 19)
				.replace('T', '_')
				.replace(/:/g, '-')}`;
			const effectiveTitle = meetingName || fallback;

			await indexedDBService.saveMeetingMetadata({
				meetingId,
				title: effectiveTitle,
				startTime: Date.now(),
				lastUpdated: Date.now(),
				transcriptCount: 0,
				savedToSQLite: false,
				folderPath: undefined,
			});

			this.meetingTitle = effectiveTitle;

			try {
				const folderPath = await invoke<string>('get_meeting_folder_path');
				if (folderPath) {
					const metadata = await indexedDBService.getMeetingMetadata(meetingId);
					if (metadata) {
						metadata.folderPath = folderPath;
						await indexedDBService.saveMeetingMetadata(metadata);
					}
				}
			} catch {
				// Non-fatal — will be set on stop if recording completes normally.
			}
		} catch (error) {
			console.error('[TranscriptStore] Failed to initialise meeting:', error);
		}
	}

	async #handleRecordingStopped(folderPath: string | undefined): Promise<void> {
		if (!this.currentMeetingId || !folderPath) return;
		try {
			const metadata = await indexedDBService.getMeetingMetadata(this.currentMeetingId);
			if (metadata) {
				metadata.folderPath = folderPath;
				await indexedDBService.saveMeetingMetadata(metadata);
			}
		} catch (error) {
			console.error('[TranscriptStore] Failed to update folder path on stop:', error);
		}
	}

	#handleTranscriptUpdate(update: TranscriptUpdate): void {
		if (this.#buffer.has(update.sequence_id)) return;

		const newTranscript: Transcript = {
			id: `${Date.now()}-${this.#transcriptCounter++}`,
			text: update.text,
			timestamp: update.timestamp,
			sequence_id: update.sequence_id,
			chunk_start_time: update.chunk_start_time,
			is_partial: update.is_partial,
			confidence: update.confidence,
			audio_start_time: update.audio_start_time,
			audio_end_time: update.audio_end_time,
			duration: update.duration,
			speaker: speakerFromSource(update.source),
		};

		this.#buffer.set(update.sequence_id, newTranscript);

		// Fire-and-forget persistence to IndexedDB.
		if (this.currentMeetingId) {
			indexedDBService
				.saveTranscript(this.currentMeetingId, update)
				.catch((err) => console.warn('IndexedDB save failed:', err));
		}

		if (this.#processingTimer !== null) {
			clearTimeout(this.#processingTimer);
		}
		this.#processingTimer = setTimeout(() => this.#processBuffer(false), 10);
	}

	#processBuffer(forceFlush: boolean): void {
		const sequential: Transcript[] = [];
		let nextSequence = this.#lastProcessedSequence + 1;
		while (this.#buffer.has(nextSequence)) {
			const t = this.#buffer.get(nextSequence);
			if (!t) break;
			sequential.push(t);
			this.#buffer.delete(nextSequence);
			this.#lastProcessedSequence = nextSequence;
			nextSequence++;
		}

		const now = Date.now();
		const staleThresholdMs = 100;
		const stale: Transcript[] = [];
		const recent: Transcript[] = [];
		const forced: Transcript[] = [];

		for (const [sequenceId, transcript] of this.#buffer.entries()) {
			if (forceFlush) {
				forced.push(transcript);
				this.#buffer.delete(sequenceId);
				continue;
			}
			const idTimestamp = parseInt(transcript.id.split('-')[0] ?? '0', 10);
			const age = now - idTimestamp;
			if (age > staleThresholdMs) {
				stale.push(transcript);
				this.#buffer.delete(sequenceId);
			} else {
				recent.push(transcript);
				this.#buffer.delete(sequenceId);
			}
		}

		const sortByChunkThenSequence = (arr: Transcript[]): Transcript[] =>
			arr.sort((a, b) => {
				const chunkDiff = (a.chunk_start_time ?? 0) - (b.chunk_start_time ?? 0);
				if (chunkDiff !== 0) return chunkDiff;
				return (a.sequence_id ?? 0) - (b.sequence_id ?? 0);
			});

		const allNew = [
			...sequential,
			...sortByChunkThenSequence(recent),
			...sortByChunkThenSequence(stale),
			...sortByChunkThenSequence(forced),
		];

		if (allNew.length === 0) return;

		const existingSequenceIds = new Set(
			this.transcripts.map((t) => t.sequence_id).filter((id): id is number => id !== undefined),
		);
		const uniqueNew = allNew.filter(
			(t) => t.sequence_id !== undefined && !existingSequenceIds.has(t.sequence_id),
		);
		if (uniqueNew.length === 0) return;

		this.transcripts = [...this.transcripts, ...uniqueNew].sort((a, b) => {
			const chunkDiff = (a.chunk_start_time ?? 0) - (b.chunk_start_time ?? 0);
			if (chunkDiff !== 0) return chunkDiff;
			return (a.sequence_id ?? 0) - (b.sequence_id ?? 0);
		});
	}

	async #syncFromBackend(): Promise<void> {
		try {
			const history = await transcriptService.getTranscriptHistory();
			// Defensive: a webview reload can orphan the invoke callback so the promise
			// resolves undefined instead of the segment array. Skip rather than crash.
			if (!Array.isArray(history)) return;
			const formatted: Transcript[] = history.map((segment) => {
				const s = segment as unknown as Transcript & { display_time?: string };
				return {
					id: s.id,
					text: s.text,
					timestamp: s.display_time ?? s.timestamp,
					sequence_id: s.sequence_id,
					chunk_start_time: s.audio_start_time,
					is_partial: false,
					confidence: s.confidence,
					audio_start_time: s.audio_start_time,
					audio_end_time: s.audio_end_time,
					duration: s.duration,
					speaker: s.speaker,
				};
			});
			this.transcripts = formatted;

			const meetingName = await recordingService.getRecordingMeetingName();
			if (meetingName) {
				this.meetingTitle = meetingName;
			}
		} catch (error) {
			console.error('[TranscriptStore] Reload sync failed:', error);
		}
	}

	#cleanup(): void {
		if (this.#processingTimer !== null) {
			clearTimeout(this.#processingTimer);
			this.#processingTimer = null;
		}
		for (const fn of this.#unsubscribers) {
			fn();
		}
		this.#unsubscribers = [];
		this.#disposeEffectRoot?.();
		this.#disposeEffectRoot = null;
		this.#started = false;
	}
}

export const transcripts = new TranscriptStore();
