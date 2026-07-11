/**
 * Helpers for recording and displaying global-shortcut accelerators
 * (Tauri accelerator strings like "CmdOrCtrl+Alt+R").
 */

/** Keys we allow as the non-modifier part of a global shortcut, from e.code. */
const CODE_TO_KEY: Record<string, string> = {
	Space: 'Space',
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	Home: 'Home',
	End: 'End',
	PageUp: 'PageUp',
	PageDown: 'PageDown',
};

function keyFromCode(code: string): string | null {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
	return CODE_TO_KEY[code] ?? null;
}

/**
 * Build an accelerator from a keydown event, or null when the event isn't a
 * usable chord (modifier-only, unmapped key, or no modifier on a non-F key).
 * The platform-primary modifier (Cmd on macOS, Ctrl elsewhere) is emitted as
 * "CmdOrCtrl" so a binding recorded on one platform stays sensible on another.
 */
export function keyEventToAccelerator(
	e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
	isMac: boolean,
): string | null {
	const key = keyFromCode(e.code);
	if (!key) return null;

	const mods: string[] = [];
	const primary = isMac ? e.metaKey : e.ctrlKey;
	const secondary = isMac ? e.ctrlKey : e.metaKey;
	if (primary) mods.push('CmdOrCtrl');
	if (secondary) mods.push(isMac ? 'Ctrl' : 'Super');
	if (e.altKey) mods.push('Alt');
	if (e.shiftKey) mods.push('Shift');

	// Global shortcuts need a modifier, except bare function keys.
	if (mods.length === 0 && !/^F\d+$/.test(key)) return null;
	return [...mods, key].join('+');
}

const MAC_MOD_SYMBOLS: Record<string, string> = {
	cmdorctrl: '⌘',
	commandorcontrol: '⌘',
	cmd: '⌘',
	command: '⌘',
	super: '⌘',
	meta: '⌘',
	ctrl: '⌃',
	control: '⌃',
	alt: '⌥',
	option: '⌥',
	shift: '⇧',
};

const OTHER_MOD_LABELS: Record<string, string> = {
	cmdorctrl: 'Ctrl',
	commandorcontrol: 'Ctrl',
	cmd: 'Win',
	command: 'Win',
	super: 'Win',
	meta: 'Win',
	ctrl: 'Ctrl',
	control: 'Ctrl',
	alt: 'Alt',
	option: 'Alt',
	shift: 'Shift',
};

/** Human-readable form: "⌘⌥R" on macOS, "Ctrl+Alt+R" elsewhere. */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
	const parts = accelerator.split('+').filter(Boolean);
	const key = parts[parts.length - 1];
	if (key === undefined) return accelerator;
	const keyLabel = key.length === 1 ? key.toUpperCase() : key;
	const mods = parts.slice(0, -1);
	if (isMac) {
		const symbols = mods.map((m) => MAC_MOD_SYMBOLS[m.toLowerCase()] ?? m);
		return `${symbols.join('')}${keyLabel}`;
	}
	const labels = mods.map((m) => OTHER_MOD_LABELS[m.toLowerCase()] ?? m);
	return [...labels, keyLabel].join('+');
}
