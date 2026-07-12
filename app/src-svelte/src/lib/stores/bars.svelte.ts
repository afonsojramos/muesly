/**
 * Bars store: unifies the static catalog (muesly built-ins + optionally the
 * gitignored imported set) with the user's own DB-persisted bars, and owns
 * create/update/delete. Consumed by the Bars page and both chat surfaces.
 */

import { commands, type BarInput, type UserBar } from '$lib/bindings';
import {
	catalogForSurface,
	CATALOG_BARS,
	SCENARIOS_BY_SURFACE,
	type Bar,
	type BarScenario,
	type ChatSurface,
} from '$lib/bars/catalog';
import { fetchPopularBars, trackBarUsage } from '$lib/bars/popularity';
import { toast } from '$lib/toast';

const SCENARIOS: BarScenario[] = ['before', 'during', 'after', 'across'];
function isScenario(s: string): s is BarScenario {
	return (SCENARIOS as string[]).includes(s);
}

function toBar(u: UserBar): Bar {
	return {
		id: u.id,
		title: u.title,
		description: u.description,
		prompt: u.prompt,
		scenarios: u.scenarios.filter(isScenario),
		icon: u.icon,
		source: 'user',
	};
}

class BarsStore {
	#user = $state<Bar[]>([]);
	#loaded = false;
	/** Community usage counts (catalog bars), `bar id -> uses`. */
	#popular = $state<Record<string, number>>({});

	/** User bars first (most recently edited), then the static catalog. */
	get all(): Bar[] {
		return [...this.#user, ...CATALOG_BARS];
	}

	/** The user's own bars only. */
	get mine(): Bar[] {
		return this.#user;
	}

	/** Built-in + imported bars (the "Discover" set). */
	get catalog(): Bar[] {
		return CATALOG_BARS;
	}

	/** Bars a chat surface offers: matching user bars first, then the catalog. */
	forSurface(surface: ChatSurface): Bar[] {
		const scenarios = SCENARIOS_BY_SURFACE[surface];
		const mine = this.#user.filter((b) => b.scenarios.some((s) => scenarios.includes(s)));
		return [...mine, ...catalogForSurface(surface)];
	}

	async load(): Promise<void> {
		const res = await commands.barsList();
		if (res.status === 'ok') this.#user = res.data.map(toBar);
		this.#loaded = true;
	}

	/** Load user bars once (built-in + imported are always available). */
	async ensureLoaded(): Promise<void> {
		if (!this.#loaded) await this.load();
	}

	/** Community usage count for a bar (0 if unknown / not a catalog bar). */
	usesFor(id: string): number {
		return this.#popular[id] ?? 0;
	}

	/** Fetch community popularity counts (best-effort; safe to call repeatedly). */
	async loadPopular(): Promise<void> {
		this.#popular = await fetchPopularBars();
	}

	/** Record a catalog bar being run (fire-and-forget; user bars are ignored). */
	track(bar: Bar): void {
		if (bar.source === 'user') return;
		void trackBarUsage([bar.id]);
	}

	async save(input: BarInput): Promise<Bar | null> {
		const res = await commands.barsUpsert(input);
		if (res.status === 'error') {
			toast.error('Failed to save bar', { description: res.error });
			return null;
		}
		await this.load();
		return toBar(res.data);
	}

	async remove(id: string): Promise<void> {
		const res = await commands.barsDelete(id);
		if (res.status === 'error') {
			toast.error('Failed to delete bar', { description: res.error });
			return;
		}
		this.#user = this.#user.filter((r) => r.id !== id);
	}
}

export const bars = new BarsStore();
