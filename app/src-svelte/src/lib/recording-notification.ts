/**
 * Recording notification.
 *
 * Shows a compliance reminder toast when recording starts, gated by the
 * `show_recording_notification` preference. Mirrors the React
 * showRecordingNotification helper — the interactive "don't show again"
 * checkbox isn't representable through the toast abstraction, so this port
 * surfaces the reminder text and keeps the preference gate.
 */

import { toast } from '$lib/toast';

export async function showRecordingNotification(): Promise<void> {
	try {
		const { Store } = await import('@tauri-apps/plugin-store');
		const store = await Store.load('preferences.json');
		const showNotification = (await store.get<boolean>('show_recording_notification')) ?? true;

		if (showNotification) {
			toast.info('🔴 Recording Started', {
				description: 'Inform all participants this meeting is being recorded.',
				duration: 10000
			});
		}
	} catch (notificationError) {
		console.error('Failed to show recording notification:', notificationError);
		// Don't fail the recording if notification fails.
	}
}
