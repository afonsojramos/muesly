/**
 * useTranscriptRecovery
 *
 * Orchestrates transcript recovery operations for interrupted meetings.
 * Detects, previews, recovers, and deletes meetings stored in IndexedDB.
 *
 * Mirrors the React useTranscriptRecovery hook.
 */

import { invoke } from '@tauri-apps/api/core';

import {
	indexedDBService,
	type MeetingMetadata,
	type StoredTranscript,
} from '$lib/services/indexed-db';
import { storageService } from '$lib/services/storage';
import type { Transcript } from '$lib/types';

export interface AudioRecoveryStatus {
	status: string; // "success" | "partial" | "failed" | "none"
	chunk_count: number;
	estimated_duration_seconds: number;
	audio_file_path?: string;
	message: string;
}

export interface RecoverResult {
	success: boolean;
	audioRecoveryStatus?: AudioRecoveryStatus | null;
	meetingId?: string;
}

export interface UseTranscriptRecovery {
	readonly recoverableMeetings: MeetingMetadata[];
	readonly isLoading: boolean;
	readonly isRecovering: boolean;
	checkForRecoverableTranscripts: () => Promise<void>;
	recoverMeeting: (meetingId: string) => Promise<RecoverResult>;
	loadMeetingTranscripts: (meetingId: string) => Promise<StoredTranscript[]>;
	deleteRecoverableMeeting: (meetingId: string) => Promise<void>;
}

export function useTranscriptRecovery(): UseTranscriptRecovery {
	let recoverableMeetings = $state<MeetingMetadata[]>([]);
	let isLoading = $state(false);
	let isRecovering = $state(false);

	const checkForRecoverableTranscripts = async (): Promise<void> => {
		isLoading = true;
		try {
			const meetings = await indexedDBService.getAllMeetings();

			// Keep meetings inside the 7-day retention window but older than 2s,
			// so the just-stopped current session isn't offered for recovery.
			const cutoffTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
			const secondsAgo = Date.now() - 2 * 1000;

			const recentMeetings = meetings.filter((m) => {
				const isWithinRetention = m.lastUpdated > cutoffTime;
				const isOldEnough = m.lastUpdated < secondsAgo;
				return isWithinRetention && isOldEnough;
			});

			const meetingsWithAudioStatus = await Promise.all(
				recentMeetings.map(async (meeting) => {
					if (meeting.folderPath) {
						try {
							const hasAudio = await invoke<boolean>('has_audio_checkpoints', {
								meetingFolder: meeting.folderPath,
							});
							return {
								...meeting,
								folderPath: hasAudio ? meeting.folderPath : undefined,
							};
						} catch (error) {
							console.warn('Failed to check audio for meeting:', error);
							return { ...meeting, folderPath: undefined };
						}
					}
					return meeting;
				}),
			);

			recoverableMeetings = meetingsWithAudioStatus;
		} catch (error) {
			console.error('Failed to check for recoverable transcripts:', error);
			recoverableMeetings = [];
		} finally {
			isLoading = false;
		}
	};

	const loadMeetingTranscripts = async (meetingId: string): Promise<StoredTranscript[]> => {
		try {
			const stored = await indexedDBService.getTranscripts(meetingId);
			stored.sort((a, b) => (a.sequenceId || 0) - (b.sequenceId || 0));
			return stored;
		} catch (error) {
			console.error('Failed to load meeting transcripts:', error);
			return [];
		}
	};

	const recoverMeeting = async (meetingId: string): Promise<RecoverResult> => {
		isRecovering = true;
		try {
			const metadata = await indexedDBService.getMeetingMetadata(meetingId);
			if (!metadata) {
				throw new Error('Meeting metadata not found');
			}

			const stored = await loadMeetingTranscripts(meetingId);
			if (stored.length === 0) {
				throw new Error('No transcripts found for this meeting');
			}

			let folderPath = metadata.folderPath;

			if (!folderPath) {
				try {
					folderPath = await invoke<string>('get_meeting_folder_path');
				} catch {
					folderPath = undefined;
				}
			}

			let audioRecoveryStatus: AudioRecoveryStatus | null = null;
			if (folderPath) {
				try {
					audioRecoveryStatus = await invoke<AudioRecoveryStatus>(
						'recover_audio_from_checkpoints',
						{ meetingFolder: folderPath, sampleRate: 48000 },
					);
				} catch (error) {
					console.error('Audio recovery failed:', error);
					audioRecoveryStatus = {
						status: 'failed',
						chunk_count: 0,
						estimated_duration_seconds: 0,
						message: error instanceof Error ? error.message : 'Unknown error',
					};
				}
			} else {
				audioRecoveryStatus = {
					status: 'none',
					chunk_count: 0,
					estimated_duration_seconds: 0,
					message: 'No folder path available',
				};
			}

			const formattedTranscripts: Transcript[] = stored.map((t, index) => ({
				id: t.id?.toString() || `${Date.now()}-${index}`,
				text: t.text,
				timestamp: t.timestamp,
				sequence_id: t.sequenceId ?? index,
				chunk_start_time: t.chunk_start_time as number | undefined,
				is_partial: (t.is_partial as boolean | undefined) ?? false,
				confidence: t.confidence,
				audio_start_time: t.audio_start_time,
				audio_end_time: t.audio_end_time,
				duration: t.duration,
				speaker:
					t.source === 'mic' || t.source === 'system'
						? (t.source as string)
						: (t.speaker as string | undefined),
			}));

			const saveResponse = await storageService.saveMeeting(
				metadata.title,
				formattedTranscripts,
				folderPath ?? null,
			);

			const savedMeetingId = saveResponse.meeting_id;

			await indexedDBService.markMeetingSaved(meetingId);

			if (folderPath) {
				try {
					await invoke('cleanup_checkpoints', { meetingFolder: folderPath });
				} catch (error) {
					console.warn('Checkpoint cleanup failed (non-fatal):', error);
				}
			}

			recoverableMeetings = recoverableMeetings.filter((m) => m.meetingId !== meetingId);

			return {
				success: true,
				audioRecoveryStatus,
				meetingId: savedMeetingId,
			};
		} catch (error) {
			console.error('Failed to recover meeting:', error);
			throw error;
		} finally {
			isRecovering = false;
		}
	};

	const deleteRecoverableMeeting = async (meetingId: string): Promise<void> => {
		try {
			await indexedDBService.deleteMeeting(meetingId);
			recoverableMeetings = recoverableMeetings.filter((m) => m.meetingId !== meetingId);
		} catch (error) {
			console.error('Failed to delete meeting:', error);
			throw error;
		}
	};

	return {
		get recoverableMeetings() {
			return recoverableMeetings;
		},
		get isLoading() {
			return isLoading;
		},
		get isRecovering() {
			return isRecovering;
		},
		checkForRecoverableTranscripts,
		recoverMeeting,
		loadMeetingTranscripts,
		deleteRecoverableMeeting,
	};
}
