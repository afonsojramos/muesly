/**
 * Update notification
 *
 * Surfaces an "update available" toast with a "Download & Install" action and
 * exposes a global callback that the tray menu / notification can use to open
 * the update dialog.
 *
 * The update-available toast carries a "Download & Install" action that opens
 * the update dialog through the globally-registered callback (the same path the
 * tray "check-updates-from-tray" event uses); `onUpdateClick` lets a caller
 * override the registered callback for a single invocation.
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
		duration: 10000,
		action: {
			label: 'Download & Install',
			onClick: () => triggerUpdateDialog(),
		},
	});
}
