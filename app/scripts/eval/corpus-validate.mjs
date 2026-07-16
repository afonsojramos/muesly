#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus } from './corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultManifest = path.join(here, 'corpus-manifest.json');
const manifestPath = process.argv[2] ?? defaultManifest;

try {
	const corpus = loadCorpus(manifestPath);
	const participantSamples = corpus.samples.filter(
		(sample) => sample.provenance.basis === 'participant-consent',
	).length;
	console.log(
		`${corpus.corpus_id}: ${corpus.samples.length} sample(s), ${participantSamples} participant-consented`,
	);
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
