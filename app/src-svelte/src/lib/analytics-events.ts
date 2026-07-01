/**
 * Typed analytics event registry — Plan 031 thin slice.
 *
 * Each key is an event name; the value is a readonly tuple of the property keys
 * that event is allowed to carry. The `track` wrapper below enforces that call
 * sites can only pass declared keys.
 *
 * Add new events here before writing the call site. To migrate an existing
 * Analytics.track(...) call, add its event + properties to REGISTRY, then swap
 * the call to use the typed `track` from this module.
 *
 * Events assembled entirely in Rust (e.g. meeting_ended via track_meeting_ended)
 * do NOT flow through this path; they are governed by the SENSITIVE_PROPERTY_KEYS
 * denylist in analytics/client.rs. See docs/analytics-events.md for the full
 * migration outline.
 */
import { Analytics } from '$lib/analytics';

export const REGISTRY = {
	microphone_selected: ['device_category', 'is_bluetooth', 'has_system_audio'],
	system_audio_selected: ['device_category', 'is_bluetooth', 'has_microphone'],
	theme_changed: ['theme'],
} as const;

export type EventName = keyof typeof REGISTRY;
export type PropsOf<E extends EventName> = Record<(typeof REGISTRY)[E][number], string>;

/**
 * Type-safe wrapper around Analytics.track for registered events.
 * The compiler rejects any property key not declared in REGISTRY for the given event.
 */
export function track<E extends EventName>(event: E, props: PropsOf<E>): Promise<void> {
	return Analytics.track(event, props);
}
