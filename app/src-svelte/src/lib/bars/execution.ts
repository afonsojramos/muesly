export interface BarExecution {
	barId: string;
	barTitle: string;
	/** Fully interpolated prompt used for this run. */
	barPrompt: string;
}
