/**
 * Side panel (Transcript / Notes) UI state, held above the per-meeting view so
 * it persists while navigating between meetings. The meeting detail subtree is
 * keyed by `meeting.id` and fully remounts per meeting; keeping open/tab/width
 * in this module singleton means the panel stays as the user left it.
 *
 * Session-only: an in-memory singleton resets to defaults on app restart (no
 * localStorage). `open` defaults to true on wide windows, where the panel
 * doesn't squeeze the note into a sliver.
 */
export type SidePanelTab = 'transcript' | 'notes';

export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_MAX_WIDTH = 640;
/** The summary column always keeps at least this much room. */
export const SIDE_PANEL_SUMMARY_MIN_WIDTH = 400;

class SidePanelState {
	open = $state(
		typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches
	);
	activeTab = $state<SidePanelTab>('transcript');
	width = $state(360);

	toggle = (): void => {
		this.open = !this.open;
	};
}

export const sidePanelState = new SidePanelState();
