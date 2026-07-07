import { listen } from '@tauri-apps/api/event';
import { commands, type PreviewEvent } from '$lib/bindings';

/**
 * Home "Coming up" preview. The backend persists the preview and serves it
 * instantly (so the dashboard paints without a live fetch), refreshing it in the
 * background when stale and emitting `upcoming-events-updated` when fresh data
 * lands. This store mirrors that: read the cache on demand and re-read on the
 * event. In-flight reads coalesce.
 */
class UpcomingEventsStore {
	events = $state<PreviewEvent[]>([]);
	loaded = $state(false);

	#inFlight: Promise<void> | null = null;
	#listening = false;

	/** Load the preview once, and keep it fresh via the backend refresh event. */
	async ensure(): Promise<void> {
		this.#listenForUpdates();
		if (this.loaded) return;
		return this.refresh();
	}

	/** (Re)read the preview from the backend cache; coalesces concurrent callers. */
	async refresh(): Promise<void> {
		if (this.#inFlight) return this.#inFlight;
		this.#inFlight = (async () => {
			try {
				const res = await commands.calendarPreviewUpcoming();
				if (res.status === 'ok') {
					this.events = res.data;
					this.loaded = true;
				}
			} finally {
				this.#inFlight = null;
			}
		})();
		return this.#inFlight;
	}

	// Re-read when the backend's background refresh lands. Registered once for the
	// app's lifetime (the store is a module singleton).
	#listenForUpdates(): void {
		if (this.#listening || typeof window === 'undefined') return;
		this.#listening = true;
		void listen('upcoming-events-updated', () => void this.refresh());
	}
}

export const upcomingEvents = new UpcomingEventsStore();
