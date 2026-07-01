import { describe, it, expect } from 'vitest';
import { REGISTRY } from './analytics-events';

/**
 * Property keys that must never appear in any analytics event, per
 * AnalyticsDataModal.svelte ("What We DON'T Collect") and PRIVACY_POLICY.md
 * ("What we never collect"). Must stay in sync with SENSITIVE_PROPERTY_KEYS in
 * app/src-tauri/src/analytics/client.rs.
 */
const FORBIDDEN_KEYS = [
	'device_name',
	'meeting_title',
	'meeting_name',
	'user_agent',
	'file_name',
	'file_path',
];

describe('analytics event registry conformance', () => {
	it('no registered event declares a forbidden property key', () => {
		for (const [eventName, allowedKeys] of Object.entries(REGISTRY)) {
			for (const key of allowedKeys) {
				expect(
					FORBIDDEN_KEYS,
					`event "${eventName}" declares forbidden property key "${key}"`,
				).not.toContain(key);
			}
		}
	});

	it('microphone_selected declares exactly the expected safe keys', () => {
		expect(REGISTRY.microphone_selected).toEqual([
			'device_category',
			'is_bluetooth',
			'has_system_audio',
		]);
	});

	it('system_audio_selected declares exactly the expected safe keys', () => {
		expect(REGISTRY.system_audio_selected).toEqual([
			'device_category',
			'is_bluetooth',
			'has_microphone',
		]);
	});

	it('theme_changed declares exactly the expected safe keys', () => {
		expect(REGISTRY.theme_changed).toEqual(['theme']);
	});
});
