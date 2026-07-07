/**
 * Theme store.
 *
 * Applies the `dark` class on <html> (the `:root.dark` token set in app.css),
 * persists the user's choice in localStorage, and follows the OS setting when in
 * 'system' mode. The initial class is set by an inline script in app.html to
 * avoid a flash of the wrong theme; this store keeps it in sync at runtime.
 */

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'muesly-theme';

function isThemeMode(value: string | null): value is ThemeMode {
	return value === 'light' || value === 'dark' || value === 'system';
}

class ThemeStore {
	mode = $state<ThemeMode>('system');
	#mediaQuery: MediaQueryList | null = null;
	#initialized = false;
	#transitionTimer: ReturnType<typeof setTimeout> | undefined;

	/** Read the saved preference, start following the OS, and apply the theme. */
	init(): void {
		if (this.#initialized || typeof window === 'undefined') return;
		this.#initialized = true;

		const saved = localStorage.getItem(STORAGE_KEY);
		this.mode = isThemeMode(saved) ? saved : 'system';

		this.#mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		this.#mediaQuery.addEventListener('change', this.#onSystemChange);

		this.apply();
	}

	setMode(mode: ThemeMode): void {
		this.mode = mode;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, mode);
		}
		this.apply(true);
	}

	/** The concrete theme after resolving 'system' against the OS setting. */
	get resolved(): 'light' | 'dark' {
		if (this.mode === 'system') {
			return this.#mediaQuery?.matches ? 'dark' : 'light';
		}
		return this.mode;
	}

	#onSystemChange = (): void => {
		if (this.mode === 'system') this.apply(true);
	};

	/**
	 * Toggle the `dark` class on <html>. When `animate` is set (an explicit user
	 * switch or an OS change), briefly add `theme-transition` so the palette
	 * cross-fades instead of snapping; the class is removed once the transition
	 * finishes. The initial apply() runs without it — the page paints straight into
	 * its final theme (the FOUC script already set the class).
	 */
	private apply(animate = false): void {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		const commit = (): void => {
			root.classList.toggle('dark', this.resolved === 'dark');
		};

		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
		if (!animate || reduce) {
			commit();
			return;
		}

		// Prefer the View Transitions API: it cross-fades a snapshot of the whole
		// page, so every element switches in lockstep. Per-element CSS colour
		// transitions can't match that — nested inherited-colour transitions
		// compound and lag, so text that inherits its colour (e.g. section titles)
		// finishes noticeably late. Fall back to the CSS colour cross-fade
		// (`.theme-transition` in app.css) where the API is unavailable.
		const doc = document as Document & {
			startViewTransition?: (cb: () => void) => { finished: Promise<void> };
		};
		if (typeof doc.startViewTransition === 'function') {
			// Suppress per-element CSS transitions during the capture. Otherwise an
			// element with its own `transition-colors` gets snapshotted mid-transition
			// (still the old colour) and only reaches the new colour once the overlay
			// lifts, so it appears to switch late. With transitions off, the new
			// snapshot holds final colours and the whole page cross-fades in lockstep.
			const vt = doc.startViewTransition(() => {
				root.classList.add('theme-no-transition');
				commit();
			});
			void vt.finished.finally(() => root.classList.remove('theme-no-transition'));
			return;
		}

		root.classList.add('theme-transition');
		clearTimeout(this.#transitionTimer);
		this.#transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 400);
		commit();
	}
}

export const theme = new ThemeStore();
