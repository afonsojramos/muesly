import { describe, expect, it } from 'vitest';

import { shouldWindow, windowRange } from './windowed-list';

describe('windowRange', () => {
	it('returns empty for zero items', () => {
		expect(windowRange(0, 400, 0, 56)).toEqual({
			start: 0,
			end: 0,
			padTop: 0,
			padBottom: 0,
		});
	});

	it('covers the top of a long list with overscan', () => {
		const r = windowRange(0, 400, 200, 50, 4);
		expect(r.start).toBe(0);
		// 400/50 = 8 visible + 8 overscan
		expect(r.end).toBe(16);
		expect(r.padTop).toBe(0);
		expect(r.padBottom).toBe((200 - 16) * 50);
	});

	it('slides the window mid-list', () => {
		const r = windowRange(2500, 400, 200, 50, 2);
		// floor(2500/50)=50 → start 48, visible ~8+4=12 → end 60
		expect(r.start).toBe(48);
		expect(r.end).toBe(60);
		expect(r.padTop).toBe(48 * 50);
	});

	it('clamps to list end', () => {
		const r = windowRange(9000, 400, 100, 50, 8);
		expect(r.end).toBe(100);
		expect(r.padBottom).toBe(0);
	});
});

describe('shouldWindow', () => {
	it('skips short lists', () => {
		expect(shouldWindow(20)).toBe(false);
		expect(shouldWindow(80)).toBe(true);
	});
});
