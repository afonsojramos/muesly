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
		if (animate) {
			root.classList.add('theme-transition');
			clearTimeout(this.#transitionTimer);
			this.#transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 400);
		}
		root.classList.toggle('dark', this.resolved === 'dark');
	}
}

export const theme = new ThemeStore();
