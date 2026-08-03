/**
 * useUpdateCheck
 *
 * Polls the Tauri updater plugin for available app updates.
 */

import { onMount } from 'svelte';
import { updateService, type UpdateInfo } from '$lib/services/update';

export interface UseUpdateCheckOptions {
	checkOnMount?: boolean;
	onUpdateAvailable?: (info: UpdateInfo) => void;
}

export interface UseUpdateCheck {
	readonly updateInfo: UpdateInfo | null;
	readonly isChecking: boolean;
	checkForUpdates: (force?: boolean) => Promise<void>;
}

// Module-scoped shared state: every consumer (the app shell's UpdateDialog, the
// About dialog's manual check) sees the same availability, so a manual check in
// one place makes the update dialog usable everywhere.
let updateInfo = $state<UpdateInfo | null>(null);
let isChecking = $state(false);

export function useUpdateCheck(options: UseUpdateCheckOptions = {}): UseUpdateCheck {
	const { checkOnMount = true, onUpdateAvailable } = options;

	const checkForUpdates = async (force = false): Promise<void> => {
		if (!force && updateService.wasCheckedRecently()) return;
		if (isChecking) return;

		isChecking = true;
		try {
			const info = await updateService.checkForUpdates(force);
			updateInfo = info;
			if (info.available && onUpdateAvailable) {
				onUpdateAvailable(info);
			}
		} catch (error) {
			console.error('Failed to check for updates:', error);
		} finally {
			isChecking = false;
		}
	};

	onMount(() => {
		// A dev binary cannot install GitHub release artifacts and the latest
		// endpoint is often absent between releases. Keep manual checks available,
		// but don't turn that expected response into a startup error.
		if (!checkOnMount || import.meta.env.DEV) return;
		const timer = setTimeout(() => {
			void checkForUpdates(false);
		}, 2000);
		return () => clearTimeout(timer);
	});

	return {
		get updateInfo() {
			return updateInfo;
		},
		get isChecking() {
			return isChecking;
		},
		checkForUpdates,
	};
}
