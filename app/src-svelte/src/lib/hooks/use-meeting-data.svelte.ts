/**
 * useMeetingData
 *
 * Per-meeting view state: title editing, summary state, save-all coordination.
 *
 * Note: BlockNote-specific surface (blockNoteSummaryRef) is intentionally
 * omitted; the editor component will manage its own dirty state and expose
 * `isDirty` / `save()` via $bindable when it's ported on Phase 6.
 */

import { invoke } from '@tauri-apps/api/core';

import type { Summary } from '$lib/types';
import { Analytics } from '$lib/analytics';
import { sidebar } from '$lib/stores/sidebar.svelte';
import { toast } from '$lib/toast';

interface MeetingShape {
	id: string;
	title?: string;
	transcripts?: unknown[];
}

interface BlockNoteSnapshot {
	markdown?: string;
	summary_json?: unknown[];
}

export interface UseMeetingDataOptions {
	meeting: MeetingShape;
	summaryData: Summary | null;
}

export interface UseMeetingData {
	readonly meetingTitle: string;
	readonly isEditingTitle: boolean;
	readonly isTitleDirty: boolean;
	readonly aiSummary: Summary | null;
	readonly isSaving: boolean;
	setMeetingTitle: (title: string) => void;
	setIsEditingTitle: (editing: boolean) => void;
	setAiSummary: (summary: Summary | null) => void;
	handleTitleChange: (newTitle: string) => void;
	handleSummaryChange: (newSummary: Summary) => void;
	handleSaveSummary: (summary: Summary | BlockNoteSnapshot) => Promise<void>;
	handleSaveMeetingTitle: () => Promise<boolean>;
	updateMeetingTitle: (title: string) => void;
}

export function useMeetingData({ meeting, summaryData }: UseMeetingDataOptions): UseMeetingData {
	let meetingTitle = $state(meeting.title || '+ New Call');
	let isEditingTitle = $state(false);
	let isTitleDirty = $state(false);
	let aiSummary = $state<Summary | null>(summaryData);
	let isSaving = $state(false);

	// Track external summaryData changes (e.g. parent reloads).
	$effect(() => {
		aiSummary = summaryData;
	});

	const handleTitleChange = (newTitle: string): void => {
		meetingTitle = newTitle;
		isTitleDirty = true;
		// Keep the sidebar label tracking live edits (preserving createdAt so the
		// date grouping does not collapse the note into "Earlier").
		sidebar.meetings = sidebar.meetings.map((m) =>
			m.id === meeting.id ? { ...m, title: newTitle } : m
		);
		sidebar.setCurrentMeeting({ id: meeting.id, title: newTitle });
	};

	const handleSummaryChange = (newSummary: Summary): void => {
		aiSummary = newSummary;
	};

	const handleSaveMeetingTitle = async (): Promise<boolean> => {
		try {
			await invoke('api_save_meeting_title', { meetingId: meeting.id, title: meetingTitle });
			isTitleDirty = false;

			sidebar.meetings = sidebar.meetings.map((m) =>
				m.id === meeting.id ? { ...m, title: meetingTitle } : m
			);
			sidebar.setCurrentMeeting({ id: meeting.id, title: meetingTitle });
			return true;
		} catch (error) {
			console.error('Failed to save meeting title:', error);
			return false;
		}
	};

	const handleSaveSummary = async (
		summary: Summary | BlockNoteSnapshot
	): Promise<void> => {
		try {
			const isBlockNoteShape =
				typeof summary === 'object' && summary !== null && ('markdown' in summary || 'summary_json' in summary);

			const formattedSummary: unknown = isBlockNoteShape
				? summary
				: {
						MeetingName: meetingTitle,
						MeetingNotes: {
							sections: Object.entries(summary as Summary).map(([, section]) => ({
								title: section.title,
								blocks: section.blocks
							}))
						}
					};

			await invoke('api_save_meeting_summary', {
				meetingId: meeting.id,
				summary: formattedSummary
			});
		} catch (error) {
			console.error('Failed to save meeting summary:', error);
			throw error;
		}
	};

	const updateMeetingTitle = (newTitle: string): void => {
		meetingTitle = newTitle;
		sidebar.meetings = sidebar.meetings.map((m) =>
			m.id === meeting.id ? { ...m, title: newTitle } : m
		);
		sidebar.setCurrentMeeting({ id: meeting.id, title: newTitle });
	};

	// Convenience: call from a "Save" button. Components are free to compose
	// their own save flow if they need to coordinate with an editor ref.
	void Analytics; // analytics is wired by callers as needed
	void toast;

	return {
		get meetingTitle() {
			return meetingTitle;
		},
		get isEditingTitle() {
			return isEditingTitle;
		},
		get isTitleDirty() {
			return isTitleDirty;
		},
		get aiSummary() {
			return aiSummary;
		},
		get isSaving() {
			return isSaving;
		},
		setMeetingTitle: (title: string) => {
			meetingTitle = title;
		},
		setIsEditingTitle: (editing: boolean) => {
			isEditingTitle = editing;
		},
		setAiSummary: (summary: Summary | null) => {
			aiSummary = summary;
		},
		handleTitleChange,
		handleSummaryChange,
		handleSaveSummary,
		handleSaveMeetingTitle,
		updateMeetingTitle
	};
}
