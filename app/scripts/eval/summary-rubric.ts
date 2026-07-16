#!/usr/bin/env node
/**
 * Lightweight rubric: does the summary markdown contain expected section signals?
 */
import fs from 'node:fs';

const DEFAULT_SIGNALS = [
  /summary|overview|recap/i,
  /action|next step|todo/i,
  /decision|agreed|conclusion/i,
];

export function scoreSummary(markdown, signals = DEFAULT_SIGNALS) {
  const hits = signals.filter((re) => re.test(markdown)).length;
  return { hits, total: signals.length, ratio: hits / signals.length };
}

const path = process.argv[2];
if (!path) {
  console.error('Usage: nub summary-rubric.ts <summary.md>');
  process.exit(2);
}
const md = fs.readFileSync(path, 'utf8');
const s = scoreSummary(md);
console.log(`Rubric: ${s.hits}/${s.total} (${(s.ratio * 100).toFixed(0)}%)`);
