#!/usr/bin/env node
/**
 * Word Error Rate (WER) for two plain-text files (reference, hypothesis).
 * Unicode-normalized, word-tokenized, and lowercased. Pure JS, no deps.
 */
import fs from 'node:fs';

const APOSTROPHE_VARIANTS = /[\u02bc\u2018-\u201b\uff07]/gu;
const DASH_VARIANTS = /[\u002d\u00ad\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/gu;
const WORD_TOKEN = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:'[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;

export const WER_SCORER_ID = 'muesly-wer-unicode-v1';

export function tokenizeForWer(text) {
	const normalized = text
		.normalize('NFKC')
		.toLowerCase()
		.replace(APOSTROPHE_VARIANTS, "'")
		.replace(DASH_VARIANTS, ' ');
	return normalized.match(WORD_TOKEN) ?? [];
}

/** Levenshtein distance on token arrays. */
function editDistance(a, b) {
	const columns = a.length <= b.length ? a : b;
	const rows = a.length <= b.length ? b : a;
	let previous = Array.from({ length: columns.length + 1 }, (_, index) => index);
	let current = Array.from({ length: columns.length + 1 }, () => 0);

	for (let row = 1; row <= rows.length; row++) {
		current[0] = row;
		for (let column = 1; column <= columns.length; column++) {
			const cost = rows[row - 1] === columns[column - 1] ? 0 : 1;
			current[column] = Math.min(
				previous[column] + 1,
				current[column - 1] + 1,
				previous[column - 1] + cost,
			);
		}
		[previous, current] = [current, previous];
	}

	return previous[columns.length];
}

export function wer(refText, hypText) {
	return werDetails(refText, hypText).rate;
}

export function werDetails(refText, hypText) {
	const ref = tokenizeForWer(refText);
	const hyp = tokenizeForWer(hypText);
	const wordErrors = editDistance(ref, hyp);
	return {
		referenceWords: ref.length,
		wordErrors,
		rate: ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : wordErrors / ref.length,
	};
}

// CLI entry, guarded so importing `wer()` from another module (real-run.ts)
// never parses that module's argv or exits its process.
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	let maxWerPct = null;
	const flagIdx = args.indexOf('--max-wer');
	if (flagIdx !== -1) {
		maxWerPct = Number(args[flagIdx + 1]);
		args.splice(flagIdx, 2);
		if (!Number.isFinite(maxWerPct) || maxWerPct < 0) {
			console.error('--max-wer requires a non-negative percentage');
			process.exit(2);
		}
	}
	const [refPath, hypPath] = args;
	if (!refPath || !hypPath) {
		console.error('Usage: nub wer.ts <reference.txt> <hypothesis.txt> [--max-wer <pct>]');
		process.exit(2);
	}
	const score = wer(fs.readFileSync(refPath, 'utf8'), fs.readFileSync(hypPath, 'utf8'));
	const pct = score * 100;
	console.log(`WER: ${pct.toFixed(2)}%`);
	if (maxWerPct !== null && pct > maxWerPct) {
		console.error(`FAIL: WER ${pct.toFixed(2)}% exceeds threshold ${maxWerPct}%`);
		process.exit(1);
	}
}
