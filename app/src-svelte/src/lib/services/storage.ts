/**
 * Storage Service
 *
 * Handles all meeting storage and retrieval Tauri backend calls (SQLite persistence).
 * Pure 1-to-1 wrapper - no error handling changes, exact same behavior as direct invoke calls.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Transcript } from '$lib/types';

export interface SaveMeetingRequest {
	meetingTitle: string;
	transcripts: Transcript[];
	folderPath: string | null;
}

export interface SaveMeetingResponse {
	meeting_id: string;
}

export interface Meeting {
	id: string;
	title: string;
	[key: string]: any; // Allow additional properties from backend
}

/**
 * Storage Service
 * Singleton service for managing meeting storage operations
 */
export class StorageService {
	/**
	 * Save meeting transcript to SQLite database
	 * @param meetingTitle - Title of the meeting
	 * @param transcripts - Array of transcript segments
	 * @param folderPath - Optional folder path for audio file
	 * @returns Promise with { meeting_id: string }
	 */
	async saveMeeting(
		meetingTitle: string,
		transcripts: Transcript[],
		folderPath: string | null,
	): Promise<SaveMeetingResponse> {
		return invoke<SaveMeetingResponse>('api_save_transcript', {
			meetingTitle,
			transcripts,
			folderPath,
		});
	}

	/**
	 * Get meeting details by ID
	 * @param meetingId - ID of the meeting to fetch
	 * @returns Promise with meeting details
	 */
	async getMeeting(meetingId: string): Promise<Meeting> {
		return invoke<Meeting>('api_get_meeting', { meetingId });
	}

	/**
	 * Get list of all meetings
	 * @returns Promise with array of meetings
	 */
	async getMeetings(): Promise<Meeting[]> {
		return invoke<Meeting[]>('api_get_meetings');
	}

	/**
	 * Persist the user's in-meeting notes (markdown) for a meeting.
	 */
	async saveMeetingNotes(meetingId: string, notesMarkdown: string): Promise<void> {
		await invoke('api_save_meeting_notes', { meetingId, notesMarkdown });
	}

	/**
	 * Load the user's saved notes and summary context for a meeting. Both live on
	 * the same row, so one call returns both; each is '' when nothing was saved.
	 */
	async getMeetingNotes(
		meetingId: string,
	): Promise<{ notesMarkdown: string; summaryContext: string }> {
		const response = await invoke<{
			notes_markdown?: string | null;
			summary_context?: string | null;
		}>('api_get_meeting_notes', {
			meetingId,
		});
		return {
			notesMarkdown: response.notes_markdown ?? '',
			summaryContext: response.summary_context ?? '',
		};
	}

	/**
	 * Persist the per-meeting context the user types to steer the AI summary.
	 */
	async saveMeetingSummaryContext(meetingId: string, summaryContext: string): Promise<void> {
		await invoke('api_save_meeting_summary_context', { meetingId, summaryContext });
	}
}

// Export singleton instance
export const storageService = new StorageService();
