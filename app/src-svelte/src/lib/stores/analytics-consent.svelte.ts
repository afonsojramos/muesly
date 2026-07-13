/**
 * Analytics consent store.
 *
 * Single source of truth for the analytics opt-in state. Owns the canonical
 * enable/disable sequences that were previously split across analytics-boot.ts
 * and AnalyticsConsentSwitch.svelte. Follows the same class+singleton pattern
 * as theme.svelte.ts and summary-language.svelte.ts.
 *
 * Call `analyticsConsent.init()` once from +layout.svelte's onMount (NOT an
 * $effect — see the onMount comment in +layout.svelte for why).
 */

import { getVersion } from '@tauri-apps/api/app';
import { load } from '@tauri-apps/plugin-store';
import { Analytics } from '$lib/analytics';

const isBrowser = typeof window !== 'undefined';

class AnalyticsConsentStore {
	// Opt-out by default contradicts a "fully local / private" product: analytics
	// stays off until the user explicitly opts in.
	optedIn = $state(false);
	#initialized = false;
	#beforeunloadRegistered = false;

	/** Read persisted opt-in and, if opted in, run the canonical enable sequence. */
	async init(): Promise<void> {
		if (this.#initialized) return;
		this.#initialized = true;

		try {
			const store = await load('analytics.json', {
				autoSave: false,
				defaults: { analyticsOptedIn: false },
			});
			if (!(await store.has('analyticsOptedIn'))) {
				await store.set('analyticsOptedIn', false);
				await store.save();
			}
			this.optedIn = (await store.get<boolean>('analyticsOptedIn')) ?? false;
			if (this.optedIn) await this.#enable(false);
		} catch (error) {
			console.error('Failed to initialise analytics consent:', error);
		}
	}

	/** Toggle from the UI. Persists, then runs the matching side effects. */
	async setOptedIn(enabled: boolean): Promise<void> {
		try {
			const store = await load('analytics.json', {
				autoSave: false,
				defaults: { analyticsOptedIn: true },
			});
			await store.set('analyticsOptedIn', enabled);
			await store.save();
			this.optedIn = enabled;
			if (enabled) {
				await this.#enable(true);
			} else {
				await this.#disable();
			}
		} catch (error) {
			console.error('Failed to set analytics opt-in:', error);
			// Revert optimistic state on error.
			this.optedIn = !enabled;
		}
	}

	/**
	 * Canonical enable sequence (moved verbatim from analytics-boot.ts
	 * initialiseAnalytics). The `fromToggle` flag gates the
	 * `track_analytics_enabled` invoke so it only fires on a user toggle,
	 * not on every app boot.
	 */
	async #enable(fromToggle: boolean): Promise<void> {
		// Get persistent user ID FIRST (before initializing analytics).
		const userId = await Analytics.getPersistentUserId();

		// Initialize analytics.
		await Analytics.init();

		// Get device info for initialization.
		const deviceInfo = await Analytics.getDeviceInfo();

		// Store platform info in analytics.json for quick access.
		const store = await load('analytics.json', {
			autoSave: false,
			defaults: { analyticsOptedIn: true },
		});
		await store.set('platform', deviceInfo.platform);
		await store.set('os_version', deviceInfo.os_version);
		await store.set('architecture', deviceInfo.architecture);

		// Set first launch date if not exists.
		if (!(await store.has('first_launch_date'))) {
			await store.set('first_launch_date', new Date().toISOString());
		}

		await store.save();

		// Identify user with enhanced properties immediately after init.
		const appVersion = await getVersion();
		await Analytics.identify(userId, {
			app_version: appVersion,
			platform: deviceInfo.platform,
			os_version: deviceInfo.os_version,
			architecture: deviceInfo.architecture,
			first_seen: new Date().toISOString(),
		});

		// Start analytics session with platform info.
		const sessionId = await Analytics.startSession(userId);
		if (sessionId) {
			await Analytics.trackSessionStarted(sessionId);
		}

		// Check and track first launch (after analytics is initialized).
		await Analytics.checkAndTrackFirstLaunch();

		// Track app started.
		await Analytics.trackAppStarted();

		// Check and track daily usage.
		await Analytics.checkAndTrackDailyUsage();

		// Register beforeunload session-end handler once.
		if (isBrowser && !this.#beforeunloadRegistered) {
			this.#beforeunloadRegistered = true;
			const handleBeforeUnload = (): void => {
				if (sessionId) {
					void Analytics.trackSessionEnded(sessionId);
				}
				void Analytics.cleanup();
			};
			window.addEventListener('beforeunload', handleBeforeUnload);
		}

		// Fire track_analytics_enabled only on a user-initiated toggle, not boot.
		if (fromToggle) {
			try {
				const { invoke } = await import('@tauri-apps/api/core');
				await invoke('track_analytics_enabled');
			} catch (error) {
				console.error('Failed to track analytics enabled:', error);
			}
		}
	}

	async #disable(): Promise<void> {
		try {
			const { invoke } = await import('@tauri-apps/api/core');
			await invoke('track_analytics_disabled');
		} catch (error) {
			console.error('Failed to track analytics disabled:', error);
		}
		await Analytics.disable();
	}
}

export const analyticsConsent = new AnalyticsConsentStore();
