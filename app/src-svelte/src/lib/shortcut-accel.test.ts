import { describe, expect, it } from 'vitest';

import { formatAccelerator, keyEventToAccelerator } from './shortcut-accel';

function ev(code: string, mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {}) {
	return {
		code,
		metaKey: mods.meta ?? false,
		ctrlKey: mods.ctrl ?? false,
		altKey: mods.alt ?? false,
		shiftKey: mods.shift ?? false,
	};
}

describe('keyEventToAccelerator', () => {
	it('maps the platform-primary modifier to CmdOrCtrl', () => {
		expect(keyEventToAccelerator(ev('KeyR', { meta: true, alt: true }), true)).toBe(
			'CmdOrCtrl+Alt+R',
		);
		expect(keyEventToAccelerator(ev('KeyR', { ctrl: true, alt: true }), false)).toBe(
			'CmdOrCtrl+Alt+R',
		);
	});

	it('keeps the secondary modifier distinct per platform', () => {
		expect(keyEventToAccelerator(ev('KeyD', { ctrl: true }), true)).toBe('Ctrl+D');
		expect(keyEventToAccelerator(ev('KeyD', { meta: true }), false)).toBe('Super+D');
	});

	it('maps digits, arrows, and space', () => {
		expect(keyEventToAccelerator(ev('Digit1', { meta: true }), true)).toBe('CmdOrCtrl+1');
		expect(keyEventToAccelerator(ev('ArrowUp', { ctrl: true, shift: true }), false)).toBe(
			'CmdOrCtrl+Shift+Up',
		);
		expect(keyEventToAccelerator(ev('Space', { alt: true }), true)).toBe('Alt+Space');
	});

	it('rejects modifier-less chords except function keys', () => {
		expect(keyEventToAccelerator(ev('KeyR'), true)).toBeNull();
		expect(keyEventToAccelerator(ev('F9'), true)).toBe('F9');
	});

	it('rejects unmapped keys and bare modifiers', () => {
		expect(keyEventToAccelerator(ev('MetaLeft', { meta: true }), true)).toBeNull();
		expect(keyEventToAccelerator(ev('Tab', { meta: true }), true)).toBeNull();
	});
});

describe('formatAccelerator', () => {
	it('renders macOS symbols without separators', () => {
		expect(formatAccelerator('CmdOrCtrl+Alt+R', true)).toBe('⌘⌥R');
		expect(formatAccelerator('CmdOrCtrl+Shift+D', true)).toBe('⌘⇧D');
		expect(formatAccelerator('Ctrl+Space', true)).toBe('⌃Space');
	});

	it('renders plus-separated labels elsewhere', () => {
		expect(formatAccelerator('CmdOrCtrl+Alt+R', false)).toBe('Ctrl+Alt+R');
		expect(formatAccelerator('Super+D', false)).toBe('Win+D');
		expect(formatAccelerator('F9', false)).toBe('F9');
	});
});
