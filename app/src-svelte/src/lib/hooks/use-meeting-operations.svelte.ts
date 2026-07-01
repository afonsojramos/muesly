/**
 * useMeetingOperations
 *
 * Per-meeting operations (currently just open-folder). Pure callback factory —
 * no reactive state of its own.
 */

import { invoke } from '@tauri-apps/api/core';
import { toast } from '$lib/toast';

export interface UseMeetingOperations {
	openMeetingFolder: () => Promise<void>;
}

export function useMeetingOperations(meeting: { id: string }): UseMeetingOperations {
	return {
		openMeetingFolder: async () => {
			try {
				await invoke('open_meeting_folder', { meetingId: meeting.id });
			} catch (error) {
				console.error('Failed to open meeting folder:', error);
				toast.error(typeof error === 'string' ? error : 'Failed to open recording folder');
			}
		},
	};
}
