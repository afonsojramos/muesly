/**
 * Anonymous popularity for shared catalog bars (muesly bars API).
 *
 * Only catalog bar ids (`builtin:*` / `imported:*`) are ever sent — user-created
 * bars and anything about meetings stay on-device. All calls are best-effort and
 * fully swallowed: popularity is a nice-to-have, never a dependency.
 */

const API_URL = import.meta.env.VITE_BARS_API_URL ?? 'https://api.muesly.ai';

function isCatalogId(id: string): boolean {
	return id.startsWith('builtin:') || id.startsWith('imported:');
}

/** Record that catalog bars were run. No-op for user bars; errors are ignored. */
export async function trackBarUsage(ids: string[]): Promise<void> {
	const catalog = [...new Set(ids.filter(isCatalogId))];
	if (catalog.length === 0) return;
	try {
		await fetch(`${API_URL}/bars/track`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: catalog }),
			keepalive: true,
		});
	} catch {
		// best-effort
	}
}

/** Fetch popularity counts as a `bar_id -> uses` map. Empty on any failure. */
export async function fetchPopularBars(): Promise<Record<string, number>> {
	try {
		const res = await fetch(`${API_URL}/bars/popular?limit=100`);
		if (!res.ok) return {};
		const rows = (await res.json()) as { bar_id: string; uses: number }[];
		return Object.fromEntries(rows.map((r) => [r.bar_id, r.uses]));
	} catch {
		return {};
	}
}
