import { commands, type PreviewEvent } from '$lib/bindings';

/**
 * Session cache for the home "Coming up" preview. Fetching upcoming events hits
 * the calendar sources (and the Google network), which is slow, so the list is
 * cached at module scope and served instantly on every revisit. `ensure()` does
 * stale-while-revalidate: it returns immediately when the cache is fresh, and
 * otherwise kicks off a single background refresh (in-flight requests coalesce).
 */
class UpcomingEventsStore {
	events = $state<PreviewEvent[]>([]);
	loaded = $state(false);

	#lastFetch = 0;
	#inFlight: Promise<void> | null = null;
	/** Serve the cache without refetching for this long after a successful load. */
	readonly #ttlMs = 60_000;

	/** Refresh only when the cache is empty or older than the TTL. */
	async ensure(): Promise<void> {
		if (this.loaded && Date.now() - this.#lastFetch < this.#ttlMs) return;
		return this.refresh();
	}

	/** Force a refresh, coalescing concurrent callers onto one request. */
	async refresh(): Promise<void> {
		if (this.#inFlight) return this.#inFlight;
		this.#inFlight = (async () => {
			try {
				const res = await commands.calendarPreviewUpcoming();
				if (res.status === 'ok') {
					this.events = res.data;
					this.loaded = true;
					this.#lastFetch = Date.now();
				}
			} finally {
				this.#inFlight = null;
			}
		})();
		return this.#inFlight;
	}
}

export const upcomingEvents = new UpcomingEventsStore();
