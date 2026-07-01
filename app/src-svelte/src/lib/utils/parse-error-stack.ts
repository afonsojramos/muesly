import type { ExceptionFrame } from '../bindings';

/**
 * Parse a JS error stack into structured frames for PostHog error tracking.
 * Tolerant of both formats muesly's webviews produce: Chromium/V8 on Windows
 * (`    at fn (file:line:col)`) and WebKit/JSC on macOS (`fn@file:line:col`).
 * Filenames are code locations (bundle URLs), not user data; the error message
 * is redacted separately before sending.
 */
export function parseStack(stack: string | undefined | null): ExceptionFrame[] {
	if (!stack) return [];
	const frames: ExceptionFrame[] = [];

	for (const raw of stack.split('\n')) {
		const line = raw.trim();
		if (!line) continue;

		let fn: string | null = null;
		let location: string | null = null;

		if (line.startsWith('at ')) {
			// V8: "at fn (loc)" or "at loc"
			const withParen = line.match(/^at\s+(.+?)\s+\((.+)\)$/);
			if (withParen) {
				fn = withParen[1] ?? null;
				location = withParen[2] ?? null;
			} else {
				location = line.replace(/^at\s+/, '');
			}
		} else if (line.includes('@')) {
			// WebKit/Firefox: "fn@loc" or "@loc"
			const at = line.lastIndexOf('@');
			fn = line.slice(0, at) || null;
			location = line.slice(at + 1) || null;
		} else {
			// The V8 message line ("TypeError: ...") and anything unrecognized.
			continue;
		}

		if (!location) continue;
		const { filename, lineno, colno } = splitLocation(location);
		frames.push({
			filename,
			function: fn && fn !== '<anonymous>' ? fn : null,
			lineno,
			colno,
		});
	}

	// Cap to keep payloads small; the top of the stack is the most useful.
	return frames.slice(0, 30);
}

/**
 * Split a "file:line:col" location. The filename itself may contain colons
 * (e.g. http://localhost:1420/...), so anchor on the trailing numeric groups.
 */
function splitLocation(location: string): {
	filename: string | null;
	lineno: number | null;
	colno: number | null;
} {
	const withCol = location.match(/^(.*):(\d+):(\d+)$/);
	if (withCol) {
		return { filename: withCol[1] || null, lineno: Number(withCol[2]), colno: Number(withCol[3]) };
	}
	const withLine = location.match(/^(.*):(\d+)$/);
	if (withLine) {
		return { filename: withLine[1] || null, lineno: Number(withLine[2]), colno: null };
	}
	return { filename: location || null, lineno: null, colno: null };
}
