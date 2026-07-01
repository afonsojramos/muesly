// Summary output languages supported by the two-pass summary pipeline.
// Codes and names must stay in sync with `language_name_from_code` in
// app/src-tauri/src/summary/processor.rs.

export interface SummaryLanguage {
	code: string;
	name: string;
}

/** Empty code = automatic (English base, no translation). */
export const AUTO_SUMMARY_LANGUAGE = '';

export const SUMMARY_LANGUAGES: SummaryLanguage[] = [
	{ code: 'en', name: 'English' },
	{ code: 'zh', name: 'Chinese' },
	{ code: 'zh-tw', name: 'Traditional Chinese' },
	{ code: 'de', name: 'German' },
	{ code: 'es', name: 'Spanish' },
	{ code: 'ru', name: 'Russian' },
	{ code: 'ko', name: 'Korean' },
	{ code: 'fr', name: 'French' },
	{ code: 'ja', name: 'Japanese' },
	{ code: 'pt', name: 'Portuguese' },
	{ code: 'it', name: 'Italian' },
	{ code: 'nl', name: 'Dutch' },
	{ code: 'pl', name: 'Polish' },
	{ code: 'ar', name: 'Arabic' },
	{ code: 'hi', name: 'Hindi' },
	{ code: 'ta', name: 'Tamil' },
	{ code: 'tr', name: 'Turkish' },
	{ code: 'vi', name: 'Vietnamese' },
	{ code: 'th', name: 'Thai' },
	{ code: 'id', name: 'Indonesian' },
	{ code: 'sv', name: 'Swedish' },
	{ code: 'cs', name: 'Czech' },
	{ code: 'da', name: 'Danish' },
	{ code: 'fi', name: 'Finnish' },
	{ code: 'el', name: 'Greek' },
	{ code: 'he', name: 'Hebrew' },
	{ code: 'hu', name: 'Hungarian' },
	{ code: 'no', name: 'Norwegian' },
	{ code: 'ro', name: 'Romanian' },
	{ code: 'uk', name: 'Ukrainian' },
];

export function summaryLanguageName(code: string | null | undefined): string | null {
	if (!code) return null;
	return SUMMARY_LANGUAGES.find((l) => l.code === code)?.name ?? null;
}
