/**
 * useNavigation
 *
 * Returns a navigate handler that updates the sidebar's current-meeting
 * selection and routes to the meeting-details page.
 *
 * Equivalent of the React useNavigation hook (which used Next.js useRouter).
 */

import { goto } from '$app/navigation';
import { sidebar } from '$lib/stores/sidebar.svelte';

export function useNavigation(meetingId: string, meetingTitle: string): () => Promise<void> {
	return async () => {
		sidebar.setCurrentMeeting({ id: meetingId, title: meetingTitle });
		await goto(`/meeting-details?id=${meetingId}`);
	};
}
