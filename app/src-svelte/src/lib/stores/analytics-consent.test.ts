import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @tauri-apps/plugin-store before importing the store under test.
vi.mock('@tauri-apps/plugin-store', () => {
	const storeData: Record<string, unknown> = { analyticsOptedIn: true };
	const mockStore = {
		has: vi.fn(async (key: string) => key in storeData),
		get: vi.fn(async <T>(key: string) => storeData[key] as T),
		set: vi.fn(async (key: string, value: unknown) => {
			storeData[key] = value;
		}),
		save: vi.fn(async () => {})
	};
	return {
		load: vi.fn(async () => mockStore)
	};
});

// Mock @tauri-apps/api/app (getVersion).
vi.mock('@tauri-apps/api/app', () => ({
	getVersion: vi.fn(async () => '1.0.0')
}));

// Mock @tauri-apps/api/core (invoke).
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async () => {})
}));

// Mock $lib/analytics — the store orchestrates these; we just verify calls.
vi.mock('$lib/analytics', () => ({
	Analytics: {
		getPersistentUserId: vi.fn(async () => 'test-user-id'),
		init: vi.fn(async () => {}),
		getDeviceInfo: vi.fn(async () => ({
			platform: 'macos',
			os_version: '15.0',
			architecture: 'aarch64'
		})),
		identify: vi.fn(async () => {}),
		startSession: vi.fn(async () => 'test-session-id'),
		trackSessionStarted: vi.fn(async () => {}),
		checkAndTrackFirstLaunch: vi.fn(async () => {}),
		trackAppStarted: vi.fn(async () => {}),
		checkAndTrackDailyUsage: vi.fn(async () => {}),
		trackSessionEnded: vi.fn(async () => {}),
		cleanup: vi.fn(async () => {}),
		disable: vi.fn(async () => {})
	}
}));

// Import after mocks are registered.
import { analyticsConsent } from './analytics-consent.svelte';
import { Analytics } from '$lib/analytics';

describe('analyticsConsent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('setOptedIn(false) sets optedIn to false and calls Analytics.disable', async () => {
		// Pre-condition: start opted in.
		analyticsConsent.optedIn = true;

		await analyticsConsent.setOptedIn(false);

		expect(analyticsConsent.optedIn).toBe(false);
		expect(Analytics.disable).toHaveBeenCalledOnce();
	});

	it('setOptedIn(true) sets optedIn to true', async () => {
		// Pre-condition: start opted out.
		analyticsConsent.optedIn = false;

		await analyticsConsent.setOptedIn(true);

		expect(analyticsConsent.optedIn).toBe(true);
	});
});
