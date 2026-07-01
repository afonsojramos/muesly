// Recency-first date bucketing shared by the sidebar note list and the folder
// page. Recent notes (the current week) are meant to be listed "freely" without
// a header; everything older falls into progressively wider, headed buckets.

export interface DateGroup<T> {
	label: string;
	items: T[];
}

/** Label for the current-week bucket; UIs render this group without a header. */
export const RECENT_GROUP_LABEL = 'This Week';

// Epoch millis for an ISO string; undated / unparseable sort oldest.
function dateValue(iso?: string): number {
	if (!iso) return -Infinity;
	const t = new Date(iso).getTime();
	return isNaN(t) ? -Infinity : t;
}

/**
 * Newest-first comparator for ISO timestamps. Compares parsed epoch millis, so
 * it is timezone-correct and locale-independent (unlike `String.localeCompare`,
 * which varies with the active ICU locale).
 */
export function compareByDateDesc(a?: string, b?: string): number {
	const va = dateValue(a);
	const vb = dateValue(b);
	return va === vb ? 0 : vb - va; // `===` also collapses the -Infinity/-Infinity case
}

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Bucket a single date relative to `now`: This Week / Last Week /
// Earlier This Month / month name / "month year".
function recencyLabel(iso: string | undefined, now: Date): string {
	if (!iso) return 'Earlier';
	const d = new Date(iso);
	if (isNaN(d.getTime())) return 'Earlier';

	const today = startOfDay(now);
	// Week starts Monday (getDay: 0=Sun..6=Sat).
	const daysSinceMonday = (today.getDay() + 6) % 7;
	const weekStart = new Date(today);
	weekStart.setDate(today.getDate() - daysSinceMonday);
	const lastWeekStart = new Date(weekStart);
	lastWeekStart.setDate(weekStart.getDate() - 7);
	const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

	const t = startOfDay(d).getTime();
	if (t >= weekStart.getTime()) return RECENT_GROUP_LABEL;
	if (t >= lastWeekStart.getTime()) return 'Last Week';
	// Only fires mid-month, once last week no longer reaches the 1st: notes from
	// earlier in the current month that predate last week.
	if (t >= monthStart.getTime()) return 'Earlier This Month';
	if (d.getFullYear() === now.getFullYear())
		return d.toLocaleDateString(undefined, { month: 'long' });
	return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * Group items into recency buckets, newest first. Items are sorted by date
 * descending, then folded by label into a Map — so each returned group has a
 * unique `label` (safe as an {#each} key) regardless of bucket monotonicity, and
 * first-seen order equals display order because the input is sorted newest-first.
 */
export function groupByRecency<T>(
	items: T[],
	getDate: (item: T) => string | undefined,
	now: Date = new Date(),
): DateGroup<T>[] {
	const sorted = [...items].sort((a, b) => compareByDateDesc(getDate(a), getDate(b)));
	const byLabel = new Map<string, T[]>();
	for (const item of sorted) {
		const label = recencyLabel(getDate(item), now);
		const bucket = byLabel.get(label);
		if (bucket) bucket.push(item);
		else byLabel.set(label, [item]);
	}
	return [...byLabel].map(([label, groupItems]) => ({ label, items: groupItems }));
}
