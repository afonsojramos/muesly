/**
 * usePermissionCheck
 *
 * Queries the Tauri backend for available audio devices and reports
 * microphone / system-audio availability + a checking flag.
 */

import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';

interface AudioDevice {
	name: string;
	device_type: 'Input' | 'Output';
}

export interface UsePermissionCheck {
	readonly hasMicrophone: boolean;
	readonly hasSystemAudio: boolean;
	readonly isChecking: boolean;
	readonly error: string | null;
	checkPermissions: () => Promise<{ hasMicrophone: boolean; hasSystemAudio: boolean }>;
	requestPermissions: () => Promise<void>;
}

export function usePermissionCheck(): UsePermissionCheck {
	let hasMicrophone = $state(false);
	let hasSystemAudio = $state(false);
	let isChecking = $state(true);
	let error = $state<string | null>(null);

	const checkPermissions = async (): Promise<{
		hasMicrophone: boolean;
		hasSystemAudio: boolean;
	}> => {
		isChecking = true;
		error = null;

		try {
			const devices = await invoke<AudioDevice[]>('get_audio_devices');
			const inputDevices = devices.filter((d) => d.device_type === 'Input');
			const outputDevices = devices.filter((d) => d.device_type === 'Output');

			hasMicrophone = inputDevices.length > 0;
			hasSystemAudio = outputDevices.length > 0;
			isChecking = false;

			return { hasMicrophone, hasSystemAudio };
		} catch (err) {
			// Browser dev preview (vite dev without Tauri): pretend permissions are
			// granted so recording UI can be exercised visually.
			if (
				import.meta.env.DEV &&
				typeof window !== 'undefined' &&
				!('__TAURI_INTERNALS__' in window)
			) {
				hasMicrophone = true;
				hasSystemAudio = true;
				isChecking = false;
				return { hasMicrophone: true, hasSystemAudio: true };
			}
			console.error('Failed to check audio permissions:', err);
			hasMicrophone = false;
			hasSystemAudio = false;
			isChecking = false;
			error = err instanceof Error ? err.message : 'Failed to check permissions';
			return { hasMicrophone: false, hasSystemAudio: false };
		}
	};

	const requestPermissions = async (): Promise<void> => {
		try {
			await invoke('get_audio_devices');
			setTimeout(() => {
				void checkPermissions();
			}, 1000);
		} catch (err) {
			console.error('Failed to request permissions:', err);
		}
	};

	onMount(() => {
		void checkPermissions();
	});

	return {
		get hasMicrophone() {
			return hasMicrophone;
		},
		get hasSystemAudio() {
			return hasSystemAudio;
		},
		get isChecking() {
			return isChecking;
		},
		get error() {
			return error;
		},
		checkPermissions,
		requestPermissions
	};
}
