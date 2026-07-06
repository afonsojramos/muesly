import type { PreviewEvent } from './bindings';

/** A day's worth of upcoming events, for the "Coming up" home card. */
export interface DayEvents {
	/** Stable `{#each}` key (yyyy-m-d). */
	key: string;
	day: number;
	/** Full month name, e.g. "July". */
	month: string;
	/** Short weekday, e.g. "Mon". */
	weekday: string;
	isToday: boolean;
	items: PreviewEvent[];
}

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Group upcoming preview events into per-day buckets, ascending by time (soonest
 * first). Unparseable dates are skipped. First-seen order equals display order
 * because the input is sorted before bucketing.
 */
export function groupPreviewEventsByDay(
	events: PreviewEvent[],
	now: Date = new Date(),
): DayEvents[] {
	const today = startOfDay(now).getTime();
	const sorted = [...events].sort(
		(a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
	);
	const byKey = new Map<string, DayEvents>();
	for (const ev of sorted) {
		const d = new Date(ev.start);
		if (isNaN(d.getTime())) continue;
		const sod = startOfDay(d);
		const key = `${sod.getFullYear()}-${sod.getMonth()}-${sod.getDate()}`;
		let group = byKey.get(key);
		if (!group) {
			group = {
				key,
				day: sod.getDate(),
				month: sod.toLocaleDateString(undefined, { month: 'long' }),
				weekday: sod.toLocaleDateString(undefined, { weekday: 'short' }),
				isToday: sod.getTime() === today,
				items: [],
			};
			byKey.set(key, group);
		}
		group.items.push(ev);
	}
	return [...byKey.values()];
}

/** Short local time for an event start, e.g. "12:00 PM". Empty for bad input. */
export function formatEventTime(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return '';
	return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
