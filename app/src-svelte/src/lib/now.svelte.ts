// A coarse, app-wide clock for recency bucketing. Reading `clock.now` inside a
// `$derived`/`$effect` tracks it, so time-based groupings ("This Week", "Last
// Week", …) refresh when the user returns to the window — the realistic trigger
// for a desktop app left open past midnight or a Monday rollover. Kept coarse on
// purpose: it only ticks on focus/visibility, not on a timer.
//
// Stored as epoch millis (a primitive) rather than a reactive Date, so `$state`
// never has to proxy a Date object; each read returns a fresh plain Date.
let currentMs = $state(Date.now());

if (typeof window !== 'undefined') {
	const refresh = (): void => {
		currentMs = Date.now();
	};
	window.addEventListener('focus', refresh);
	document.addEventListener('visibilitychange', refresh);
}

export const clock = {
	get now(): Date {
		return new Date(currentMs);
	}
};
