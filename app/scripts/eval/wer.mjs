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
  const ref = tokens(refText);
  const hyp = tokens(hypText);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}

const [refPath, hypPath] = process.argv.slice(2);
if (!refPath || !hypPath) {
  console.error('Usage: node wer.mjs <reference.txt> <hypothesis.txt>');
  process.exit(2);
}
const score = wer(fs.readFileSync(refPath, 'utf8'), fs.readFileSync(hypPath, 'utf8'));
console.log(`WER: ${(score * 100).toFixed(2)}%`);
process.exit(score === 0 ? 0 : 0); // always 0 for CI scaffold; print only
