/** Session-only state for the live transcript panel on the recording note. */
class LiveTranscriptPanelState {
	open = $state(typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches);

	toggle = (): void => {
		this.open = !this.open;
	};
}

export const liveTranscriptPanel = new LiveTranscriptPanelState();
