/**
 * Pure windowing helpers for long transcript lists.
 * Fixed estimated row height keeps the API simple; overscan absorbs variance.
 */

export interface WindowRange {
	/** Inclusive start index into the full list. */
	start: number;
	/** Exclusive end index. */
	end: number;
	/** Spacer height above the window (px). */
	padTop: number;
	/** Spacer height below the window (px). */
	padBottom: number;
}

/**
 * Compute which items should be mounted for a scroll viewport.
 * @param scrollTop distance scrolled from top
 * @param viewportHeight visible height of the scroll container
 * @param itemCount total items in the list
 * @param estimatedItemHeight average row height in px
 * @param overscan extra rows above/below the visible band
 */
export function windowRange(
	scrollTop: number,
	viewportHeight: number,
	itemCount: number,
	estimatedItemHeight: number,
	overscan = 8,
): WindowRange {
	if (itemCount <= 0 || estimatedItemHeight <= 0 || viewportHeight < 0) {
		return { start: 0, end: 0, padTop: 0, padBottom: 0 };
	}
	const h = estimatedItemHeight;
	const rawStart = Math.floor(Math.max(0, scrollTop) / h) - overscan;
	const start = Math.max(0, rawStart);
	const visible = Math.ceil(Math.max(viewportHeight, 1) / h) + overscan * 2;
	const end = Math.min(itemCount, start + visible);
	return {
		start,
		end,
		padTop: start * h,
		padBottom: Math.max(0, itemCount - end) * h,
	};
}

/** Whether windowing is worth enabling (short lists just render all). */
export function shouldWindow(itemCount: number, threshold = 80): boolean {
	return itemCount >= threshold;
}
