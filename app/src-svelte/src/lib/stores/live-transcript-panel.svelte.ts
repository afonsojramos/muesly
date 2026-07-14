/** Session-only state for the live transcript drop-up on the recording note. */
class LiveTranscriptPanelState {
	open = $state(false);

	toggle = (): void => {
		this.open = !this.open;
	};
}

export const liveTranscriptPanel = new LiveTranscriptPanelState();
