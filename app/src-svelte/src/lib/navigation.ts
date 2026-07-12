/**
 * Client-side navigation helpers that keep browser history sane for a
 * sidebar-driven desktop app.
 *
 * The app has two kinds of views:
 *  - Sections (`/`, `/search`, `/settings`, `/folder`, `/people`) are sidebar
 *    peers you tab between — not a drill-down path. Switching between them, or
 *    re-clicking the one you're on, must NOT stack history (that's what made
 *    clicking Search five times leave five back-stack entries).
 *  - Leaves (`/meeting-details`, `/note`) are drilled into from a section.
 *    These push, so a leaf's "back" returns to the section it came from.
 *
 * So: section navigation replaces, drilling into a leaf pushes. Section "back"
 * buttons go straight home via `goHome()` rather than walking history; only the
 * meeting-details leaf uses `history.back()` to return to its origin.
 */
import { goto } from '$app/navigation';

const SECTION_PATHS = new Set(['/', '/search', '/settings', '/folder', '/people']);

function pathOf(url: string): string {
	const q = url.indexOf('?');
	return q === -1 ? url : url.slice(0, q);
}

function isSection(path: string): boolean {
	return SECTION_PATHS.has(path);
}

/**
 * Navigate to `url`, replacing the current history entry when a push would only
 * pollute the back stack:
 *  - navigating to the URL already shown (repeat sidebar clicks), or
 *  - switching from one section to another (peer tabs).
 * Drilling from a section into a leaf pushes, so the leaf's back returns here.
 */
export function navigate(url: string): Promise<void> {
	const currentPath = window.location.pathname;
	const currentFull = currentPath + window.location.search;
	const sameUrl = currentFull === url;
	const sectionSwitch = isSection(currentPath) && isSection(pathOf(url));
	return goto(url, { replaceState: sameUrl || sectionSwitch });
}

/**
 * "Back" for a section view: return to the home list. Sections are top-level,
 * so their back is a fixed destination, not a history walk (which would retrace
 * whatever peers you visited to get here). Replaces, never stacks.
 */
export function goHome(): Promise<void> {
	return navigate('/');
}
