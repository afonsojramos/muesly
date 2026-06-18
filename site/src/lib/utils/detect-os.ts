export type OS = 'macos' | 'windows' | 'linux' | 'unknown';

/**
 * Pure platform detection. Callers pass `navigator` values so this stays
 * unit-testable and prerender-safe (no DOM access here).
 *
 * Order matters: mobile platforms are excluded first because Android user
 * agents contain "Linux" and iOS user agents contain "Mac OS X".
 */
export function detectOS(input: { userAgent?: string; platform?: string }): OS {
	const hay = `${input.userAgent ?? ''} ${input.platform ?? ''}`.toLowerCase();

	if (/android/.test(hay)) return 'unknown';
	if (/iphone|ipad|ipod/.test(hay)) return 'unknown';
	if (/mac/.test(hay)) return 'macos';
	if (/win/.test(hay)) return 'windows';
	if (/linux/.test(hay)) return 'linux';
	return 'unknown';
}
