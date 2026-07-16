import assert from 'node:assert/strict';
import test from 'node:test';

import { tokenizeForWer, wer, werDetails } from './wer.ts';

test('preserves existing case-insensitive word and punctuation behavior', () => {
	assert.deepEqual(tokenizeForWer("Hello, WORLD! It's me."), ['hello', 'world', "it's", 'me']);
	assert.equal(wer("Hello, WORLD! It's me.", "hello world it's me"), 0);
});

test('normalizes canonically equivalent multilingual letters and compatibility forms', () => {
	const reference = 'Café, ação, français, STRAẞE, office 123';
	const hypothesis = `Cafe\u0301, ac\u0327a\u0303o, franc\u0327ais, straße, oﬃce １２３`;

	assert.equal(wer(reference, hypothesis), 0);
	assert.deepEqual(tokenizeForWer(hypothesis), [
		'café',
		'ação',
		'français',
		'straße',
		'office',
		'123',
	]);
});

test('normalizes straight, curly, and modifier apostrophes while retaining contractions', () => {
	const reference = "L'homme n'est pas aujourd'hui; don't stop.";
	const hypothesis = 'L’homme n’est pas aujourd’hui; donʼt stop.';

	assert.equal(wer(reference, hypothesis), 0);
	assert.deepEqual(tokenizeForWer(hypothesis), [
		"l'homme",
		"n'est",
		'pas',
		"aujourd'hui",
		"don't",
		'stop',
	]);
});

test('treats apostrophes used as quotation marks consistently at word boundaries', () => {
	assert.equal(wer("'bonjour' 'hello'", '‘bonjour’ ‘hello’'), 0);
	assert.deepEqual(tokenizeForWer("James' 'tis"), ['james', 'tis']);
});

test('treats ASCII and common Unicode dashes as equivalent word boundaries', () => {
	const reference = 'state-of-the-art - très-bien - eins-zwei';
	const hypothesis = 'state–of—the‑art − très‐bien — eins–zwei';

	assert.equal(wer(reference, hypothesis), 0);
	assert.deepEqual(tokenizeForWer(hypothesis), [
		'state',
		'of',
		'the',
		'art',
		'très',
		'bien',
		'eins',
		'zwei',
	]);
});

test('keeps meaningful diacritic and letter differences visible to WER', () => {
	assert.deepEqual(werDetails('café groß', 'cafe gross'), {
		referenceWords: 2,
		wordErrors: 2,
		rate: 1,
	});
});

test('preserves empty-reference scoring semantics', () => {
	assert.deepEqual(werDetails('', ''), {
		referenceWords: 0,
		wordErrors: 0,
		rate: 0,
	});
	assert.deepEqual(werDetails('', 'hallucination'), {
		referenceWords: 0,
		wordErrors: 1,
		rate: 1,
	});
});
