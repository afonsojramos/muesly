import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { acquireLocalCorpusLock, releaseLocalCorpusLock } from './corpus-intake.mjs';
import { loadCorpus } from './corpus.mjs';

export function writeCorpusBoundJson(options) {
	const manifestPath = path.resolve(options.manifestPath);
	const outputPath = path.resolve(options.outputPath);
	const initialCorpus = loadCorpus(manifestPath);
	let lockPath;
	let lockToken;
	if (initialCorpus.distribution === 'local') {
		const localCorpusRoot = path.join(path.dirname(manifestPath), 'local-corpus');
		lockPath = path.join(localCorpusRoot, '.intake.lock');
		lockToken = acquireLocalCorpusLock(lockPath, localCorpusRoot, manifestPath);
	}

	const stagedOutput = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		const currentCorpus = loadCorpus(manifestPath);
		if (currentCorpus.corpus_fingerprint !== options.expectedFingerprint) {
			throw new Error('corpus changed while the benchmark was running; refusing to write stale results');
		}
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(stagedOutput, `${JSON.stringify(options.value, null, 2)}\n`);
		fs.renameSync(stagedOutput, outputPath);
	} finally {
		fs.rmSync(stagedOutput, { force: true });
		if (lockPath && lockToken) releaseLocalCorpusLock(lockPath, lockToken);
	}
}
