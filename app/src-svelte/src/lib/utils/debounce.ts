/**
 * Debounce a function: calls are coalesced until `wait` ms of quiet, then the
 * latest arguments run once. `flush()` runs a pending call immediately (used on
 * blur and component teardown so the last edit isn't lost); `cancel()` drops it.
 *
 * The timer and pending args live in the closure (never `$state`) — they are
 * non-reactive control values and proxying them would be both pointless and a
 * source of subtle reactivity loops.
 */
export interface Debounced<A extends unknown[]> {
	(...args: A): void;
	flush(): void;
	cancel(): void;
	readonly pending: boolean;
}

export function debounce<A extends unknown[]>(
	fn: (...args: A) => unknown,
	wait = 800,
): Debounced<A> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastArgs: A | null = null;

	const run = (): void => {
		const args = lastArgs;
		timer = null;
		lastArgs = null;
		if (args) fn(...args);
	};

	const debounced = ((...args: A): void => {
		lastArgs = args;
		if (timer) clearTimeout(timer);
		timer = setTimeout(run, wait);
	}) as Debounced<A>;

	debounced.flush = (): void => {
		if (timer) {
			clearTimeout(timer);
			run();
		}
	};
	debounced.cancel = (): void => {
		if (timer) clearTimeout(timer);
		timer = null;
		lastArgs = null;
	};
	Object.defineProperty(debounced, 'pending', { get: () => timer !== null });

	return debounced;
}
