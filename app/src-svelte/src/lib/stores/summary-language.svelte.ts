/**
 * Summary output language preference.
 *
 * Holds the user's default summary output language (a BCP-47 code, or empty for
 * automatic English) and persists it in localStorage. Individual meetings can
 * override this via the per-meeting metadata commands; this store is the
 * fallback default applied to new generations.
 */

import { AUTO_SUMMARY_LANGUAGE, SUMMARY_LANGUAGES } from '$lib/summary-languages';

const STORAGE_KEY = 'muesly-summary-language';

function isSupported(value: string | null): boolean {
	return value === AUTO_SUMMARY_LANGUAGE || SUMMARY_LANGUAGES.some((l) => l.code === value);
}

class SummaryLanguageStore {
	/** BCP-47 code, or '' for automatic (English base, no translation). */
	preferred = $state<string>(AUTO_SUMMARY_LANGUAGE);
	#initialized = false;

	init(): void {
		if (this.#initialized || typeof window === 'undefined') return;
		this.#initialized = true;

		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved !== null && isSupported(saved)) {
			this.preferred = saved;
		}
	}

	set(code: string): void {
		this.preferred = isSupported(code) ? code : AUTO_SUMMARY_LANGUAGE;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, this.preferred);
		}
	}
}

export const summaryLanguage = new SummaryLanguageStore();
