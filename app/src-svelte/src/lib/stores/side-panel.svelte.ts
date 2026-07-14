/**
 * Transcript drop-up state, held above the per-meeting view so chat controls and
 * timestamp links can open and focus the same transcript surface.
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
	open = $state(false);
	activeTab = $state<SidePanelTab>('transcript');
	width = $state(360);
	/** Segment id to scroll/highlight when jumping from a summary timestamp. */
	focusSegmentId = $state<string | null>(null);

	toggle = (): void => {
		this.open = !this.open;
	};

	/** Open the transcript drop-up and request focus on a segment. */
	jumpToSegment = (segmentId: string): void => {
		this.open = true;
		this.activeTab = 'transcript';
		this.focusSegmentId = segmentId;
	};
}

export const sidePanelState = new SidePanelState();
