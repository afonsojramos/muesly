#!/usr/bin/env node
/**
 * Word Error Rate (WER) for two plain-text files (reference, hypothesis).
 * Space-tokenized, lowercased. Pure JS, no deps.
 */
import fs from 'node:fs';

function tokens(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Levenshtein distance on token arrays. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function wer(refText, hypText) {
  return werDetails(refText, hypText).rate;
}

export function werDetails(refText, hypText) {
  const ref = tokens(refText);
  const hyp = tokens(hypText);
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
