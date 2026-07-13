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
const MENU_PREFERENCES_KEY = 'muesly-bar-menu-preferences';

interface MenuPreferences {
	visible: Record<string, boolean>;
	pinned: string[];
	order: string[];
	recent: string[];
}

export interface BarMenuGroups {
	pinned: Bar[];
	recent: Bar[];
	all: Bar[];
}

const EMPTY_MENU_PREFERENCES: MenuPreferences = {
	visible: {},
	pinned: [],
	order: [],
	recent: [],
};

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
	#preferencesLoaded = false;
	/** Per-catalog-bar overrides. Built-ins are shown and imported bars are hidden by default. */
	#menuPreferences = $state<MenuPreferences>(EMPTY_MENU_PREFERENCES);
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

	/** Everything currently available from a chat menu, in the user's preferred order. */
	get menu(): Bar[] {
		return this.#sortForMenu(this.all.filter((bar) => this.isInMenu(bar)));
	}

	/** Bars a chat surface offers: matching user bars first, then the catalog. */
	forSurface(surface: ChatSurface): Bar[] {
		const groups = this.groupsForSurface(surface);
		return [...groups.pinned, ...groups.recent, ...groups.all];
	}

	groupsForSurface(surface: ChatSurface): BarMenuGroups {
		const scenarios = SCENARIOS_BY_SURFACE[surface];
		const mine = this.#user.filter((b) => b.scenarios.some((s) => scenarios.includes(s)));
		const catalog = catalogForSurface(surface).filter((bar) => this.isInMenu(bar));
		const items = this.#sortForMenu([...mine, ...catalog]);
		const pinned = items.filter((bar) => this.isPinned(bar));
		const recentIds = new Map(this.#menuPreferences.recent.map((id, index) => [id, index]));
		const recent = items
			.filter((bar) => !this.isPinned(bar) && recentIds.has(bar.id))
			.sort((a, b) => recentIds.get(a.id)! - recentIds.get(b.id)!);
		const featuredIds = new Set([...pinned, ...recent].map((bar) => bar.id));
		return { pinned, recent, all: items.filter((bar) => !featuredIds.has(bar.id)) };
	}

	async load(): Promise<void> {
		const res = await commands.barsList();
		if (res.status === 'ok') this.#user = res.data.map(toBar);
		this.#loaded = true;
	}

	/** Load user bars once (built-in + imported are always available). */
	async ensureLoaded(): Promise<void> {
		this.#loadMenuPreferences();
		if (!this.#loaded) await this.load();
	}

	/** Whether a bar appears in the compact chat menus. User bars are always included. */
	isInMenu(bar: Bar): boolean {
		if (bar.source === 'user') return true;
		return this.#menuPreferences.visible[bar.id] ?? bar.source === 'builtin';
	}

	/** Add or remove a catalog bar from both context-appropriate chat menus. */
	toggleInMenu(bar: Bar): void {
		if (bar.source === 'user') return;
		this.#loadMenuPreferences();
		const visible = !this.isInMenu(bar);
		this.#menuPreferences = {
			...this.#menuPreferences,
			visible: { ...this.#menuPreferences.visible, [bar.id]: visible },
			order: visible
				? [...this.#menuPreferences.order.filter((id) => id !== bar.id), bar.id]
				: this.#menuPreferences.order,
			pinned: visible
				? this.#menuPreferences.pinned
				: this.#menuPreferences.pinned.filter((id) => id !== bar.id),
		};
		this.#persistMenuPreferences();
	}

	isPinned(bar: Bar): boolean {
		return this.#menuPreferences.pinned.includes(bar.id);
	}

	isRecent(bar: Bar): boolean {
		return this.#menuPreferences.recent.includes(bar.id);
	}

	togglePinned(bar: Bar): void {
		this.#loadMenuPreferences();
		const pinned = this.isPinned(bar)
			? this.#menuPreferences.pinned.filter((id) => id !== bar.id)
			: [bar.id, ...this.#menuPreferences.pinned];
		this.#menuPreferences = { ...this.#menuPreferences, pinned };
		this.#persistMenuPreferences();
	}

	moveInMenu(bar: Bar, direction: -1 | 1): void {
		this.#loadMenuPreferences();
		const ordered = this.menu.map((item) => item.id);
		const index = ordered.indexOf(bar.id);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= ordered.length) return;
		[ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
		this.#menuPreferences = {
			...this.#menuPreferences,
			order: ordered,
			pinned: ordered.filter((id) => this.#menuPreferences.pinned.includes(id)),
		};
		this.#persistMenuPreferences();
	}

	/** Record local recency for every bar and anonymous aggregate usage for catalog bars. */
	recordRun(bar: Bar): void {
		this.#loadMenuPreferences();
		this.#menuPreferences = {
			...this.#menuPreferences,
			recent: [bar.id, ...this.#menuPreferences.recent.filter((id) => id !== bar.id)].slice(0, 5),
		};
		this.#persistMenuPreferences();
		if (bar.source !== 'user') void trackBarUsage([bar.id]);
	}

	/** Community usage count for a bar (0 if unknown / not a catalog bar). */
	usesFor(id: string): number {
		return this.#popular[id] ?? 0;
	}

	/** Fetch community popularity counts (best-effort; safe to call repeatedly). */
	async loadPopular(): Promise<void> {
		this.#popular = await fetchPopularBars();
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

	#loadMenuPreferences(): void {
		if (this.#preferencesLoaded || typeof localStorage === 'undefined') return;
		this.#preferencesLoaded = true;
		try {
			const saved = JSON.parse(localStorage.getItem(MENU_PREFERENCES_KEY) ?? '{}') as unknown;
			if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
			const record = saved as Record<string, unknown>;
			// v1 stored the visibility map directly. Preserve it during the v2 migration.
			const rawVisible =
				record.visible && typeof record.visible === 'object' ? record.visible : record;
			const visible = Object.fromEntries(
				Object.entries(rawVisible).filter(
					(entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
				),
			);
			const strings = (value: unknown): string[] =>
				Array.isArray(value)
					? value.filter((item): item is string => typeof item === 'string')
					: [];
			this.#menuPreferences = {
				visible,
				pinned: strings(record.pinned),
				order: strings(record.order),
				recent: strings(record.recent).slice(0, 5),
			};
		} catch {
			// Ignore malformed preferences and keep the curated defaults.
		}
	}

	#persistMenuPreferences(): void {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(MENU_PREFERENCES_KEY, JSON.stringify(this.#menuPreferences));
		}
	}

	#sortForMenu(items: Bar[]): Bar[] {
		const pinned = new Map(this.#menuPreferences.pinned.map((id, index) => [id, index]));
		const order = new Map(this.#menuPreferences.order.map((id, index) => [id, index]));
		return [...items].sort((a, b) => {
			const aPinned = pinned.get(a.id);
			const bPinned = pinned.get(b.id);
			if (aPinned !== undefined || bPinned !== undefined) {
				if (aPinned === undefined) return 1;
				if (bPinned === undefined) return -1;
				return aPinned - bPinned;
			}
			const aOrder = order.get(a.id);
			const bOrder = order.get(b.id);
			if (aOrder !== undefined || bOrder !== undefined) {
				if (aOrder === undefined) return 1;
				if (bOrder === undefined) return -1;
				return aOrder - bOrder;
			}
			return 0;
		});
	}
}

export const bars = new BarsStore();
