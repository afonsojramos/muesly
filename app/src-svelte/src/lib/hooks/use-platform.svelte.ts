/**
 * usePlatform
 *
 * Detects the current OS platform via the Tauri OS plugin, with a userAgent
 * fallback for non-Tauri contexts (e.g. running the Vite dev server in a plain
 * browser tab for UI work).
 */

import { onMount } from 'svelte';

export type Platform = 'macos' | 'windows' | 'linux' | 'unknown';

declare global {
	interface Window {
		__TAURI_INTERNALS__?: unknown;
	}
}

function detectPlatformFromUserAgent(): Platform {
	if (typeof navigator === 'undefined') return 'unknown';
	const userAgent = navigator.userAgent.toLowerCase();
	if (userAgent.includes('mac')) return 'macos';
	if (userAgent.includes('win')) return 'windows';
	if (userAgent.includes('linux')) return 'linux';
	return 'unknown';
}

export interface UsePlatform {
	readonly current: Platform;
	readonly isMac: boolean;
	readonly isWindows: boolean;
	readonly isLinux: boolean;
}

export function usePlatform(): UsePlatform {
	let current = $state<Platform>(detectPlatformFromUserAgent());

	onMount(async () => {
		if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) {
			current = detectPlatformFromUserAgent();
			return;
		}

		try {
			const { platform } = await import('@tauri-apps/plugin-os');
			const name = await platform();
			switch (name) {
				case 'macos':
				case 'ios':
					current = 'macos';
					break;
				case 'windows':
					current = 'windows';
					break;
				case 'linux':
				case 'android':
					current = 'linux';
					break;
				default:
					current = 'unknown';
			}
		} catch (error) {
			console.warn('[usePlatform] Tauri platform detection failed, using user agent:', error);
			current = detectPlatformFromUserAgent();
		}
	});

	return {
		get current() {
			return current;
		},
		get isMac() {
			return current === 'macos';
		},
		get isWindows() {
			return current === 'windows';
		},
		get isLinux() {
			return current === 'linux';
		}
	};
}
