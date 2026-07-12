/**
 * Bars store: unifies the static catalog (muesly built-ins + optionally the
 * gitignored imported set) with the user's own DB-persisted bars, and owns
 * create/update/delete. Consumed by the Bars page and both chat surfaces.
 */

import { commands, type BarInput, type UserBar } from '$lib/bindings';
import { CATALOG_BARS, type Bar, type BarScope } from '$lib/bars/catalog';
import { toast } from '$lib/toast';

function isScope(s: string): s is BarScope {
	return s === 'meeting' || s === 'global';
}

function toBar(u: UserBar): Bar {
	return {
		id: u.id,
		title: u.title,
		description: u.description,
		prompt: u.prompt,
		scopes: u.scopes.filter(isScope),
		author: null,
		icon: u.icon,
		source: 'user',
	};
}

class BarsStore {
	#user = $state<Bar[]>([]);
	#loaded = false;

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

	forScope(scope: BarScope): Bar[] {
		return this.all.filter((r) => r.scopes.includes(scope));
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
