/**
 * Map a live audio level (0..1, from `recordingState.audioLevel`) to three
 * level-meter bar heights in px. Applies a perceptual (sqrt) curve plus gain so
 * quiet speech is visible without loud speech pinning the meter, a center-tallest
 * shape, and a little per-bar jitter for a lively VU feel. Returns resting-height
 * bars when the level is ~0 (silence), so the meter reacts to actual voice rather
 * than animating at random. Callers pair this with a CSS height transition, which
 * smooths the frame-to-frame steps.
 */
export function levelMeterBars(level: number, minHeight: number, maxHeight: number): string[] {
	const amp = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.8);
	return [0.72, 1, 0.72].map((scale) => {
		const jitter = 0.85 + Math.random() * 0.3;
		const height = minHeight + (maxHeight - minHeight) * Math.min(1, amp * scale * jitter);
		return `${height.toFixed(1)}px`;
	});
}
