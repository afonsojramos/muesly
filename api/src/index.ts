/**
 * muesly bars API — anonymous popularity counts for the shared bar catalog.
 *
 * By design it only ever sees public catalog bar ids (`builtin:*` / `imported:*`).
 * It never receives user-created bars, meeting content, user ids, or auth: a
 * request is just "someone ran this public bar". Reads are public.
 */
import { desc, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { barUsage } from './db/schema';

export interface Env {
	DB: D1Database;
}

/** Only shared catalog ids are accepted; user bars (`bar-<uuid>`) are rejected. */
const CATALOG_ID = /^(builtin|imported):[a-z0-9:_-]{1,80}$/i;
const MAX_BATCH = 50;
const MAX_LIMIT = 100;

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Max-Age': '86400',
};

function json(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { 'Content-Type': 'application/json', ...CORS, ...init.headers },
	});
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

		const url = new URL(req.url);
		const db = drizzle(env.DB);

		// Record uses of one or more catalog bars: { "ids": ["builtin:summary", ...] }
		if (req.method === 'POST' && url.pathname === '/bars/track') {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return json({ error: 'invalid json' }, { status: 400 });
			}
			const raw = (body as { ids?: unknown })?.ids;
			if (!Array.isArray(raw)) return json({ error: 'ids must be an array' }, { status: 400 });

			const ids = [
				...new Set(raw.filter((id): id is string => typeof id === 'string' && CATALOG_ID.test(id))),
			].slice(0, MAX_BATCH);
			if (ids.length === 0) return new Response(null, { status: 204, headers: CORS });

			const now = new Date().toISOString();
			await db
				.insert(barUsage)
				.values(ids.map((barId) => ({ barId, uses: 1, updatedAt: now })))
				.onConflictDoUpdate({
					target: barUsage.barId,
					set: { uses: sql`${barUsage.uses} + 1`, updatedAt: now },
				});
			return new Response(null, { status: 204, headers: CORS });
		}

		// Most-used bars, highest first.
		if (req.method === 'GET' && url.pathname === '/bars/popular') {
			const requested = parseInt(url.searchParams.get('limit') ?? '100', 10);
			const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requested) ? requested : 100));
			const rows = await db
				.select({ bar_id: barUsage.barId, uses: barUsage.uses })
				.from(barUsage)
				.orderBy(desc(barUsage.uses), barUsage.barId)
				.limit(limit);
			return json(rows);
		}

		if (url.pathname === '/') return json({ ok: true, service: 'muesly-api' });
		return json({ error: 'not found' }, { status: 404 });
	},
};
