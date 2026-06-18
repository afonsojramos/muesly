/**
 * Update notification
 *
 * Ports the React UpdateNotification helper: surfaces an "update available"
 * toast and exposes a global callback that the tray menu / notification can use
 * to open the update dialog.
 *
 * NOTE: the React version rendered a rich toast with an inline "View Details"
 * button (sonner supported JSX content) that opened the update dialog on click.
 * The Svelte toast abstraction ($lib/toast) renders title + description only, so
 * the toast here is a plain info toast without an inline button. The global
 * callback is still registered so the tray "check-updates-from-tray" path can
 * open the dialog; `onUpdateClick` is retained for API parity.
 */

import { toast } from '$lib/toast';
import type { UpdateInfo } from '$lib/services/update';

let globalShowDialogCallback: (() => void) | null = null;

export function setUpdateDialogCallback(callback: () => void): void {
	globalShowDialogCallback = callback;
}

/** Opens the update dialog via the supplied or globally-registered callback. */
export function triggerUpdateDialog(onUpdateClick?: () => void): void {
	if (onUpdateClick) {
		onUpdateClick();
	} else if (globalShowDialogCallback) {
		globalShowDialogCallback();
	}
}

export function showUpdateNotification(updateInfo: UpdateInfo): void {
	toast.info('Update Available', {
		description: `Version ${updateInfo.version} is now available`,
		duration: 10000
	});
}
