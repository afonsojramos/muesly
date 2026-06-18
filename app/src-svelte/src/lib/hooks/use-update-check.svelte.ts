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

export function useUpdateCheck(options: UseUpdateCheckOptions = {}): UseUpdateCheck {
	const { checkOnMount = true, onUpdateAvailable } = options;

	let updateInfo = $state<UpdateInfo | null>(null);
	let isChecking = $state(false);

	const checkForUpdates = async (force = false): Promise<void> => {
		if (!force && updateService.wasCheckedRecently()) return;

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
		if (!checkOnMount) return;
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
		checkForUpdates
	};
}
