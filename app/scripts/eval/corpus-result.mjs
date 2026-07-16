import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
	acquireLocalCorpusLock,
	hasPendingWithdrawal,
	releaseLocalCorpusLock,
} from './corpus-intake.mjs';
import { loadCorpus } from './corpus.mjs';

function validateLocalOutputPath(resultsRoot, outputPath) {
	if (path.dirname(outputPath) !== resultsRoot) {
		throw new Error(
			`local corpus outputs must be direct files in the managed results directory: ${resultsRoot}`,
		);
	}
	const resultsEntry = fs.lstatSync(resultsRoot, { throwIfNoEntry: false });
	if (resultsEntry?.isSymbolicLink()) {
		throw new Error(`local corpus results directory cannot be a symbolic link: ${resultsRoot}`);
	}
	if (resultsEntry && !resultsEntry.isDirectory()) {
		throw new Error(`local corpus results path is not a directory: ${resultsRoot}`);
	}
}

export function writeCorpusBoundFiles(options) {
	const manifestPath = path.resolve(options.manifestPath);
	const outputs = options.outputs.map((output) => ({
		contents: output.contents,
		outputPath: path.resolve(output.outputPath),
	}));
	if (outputs.length === 0) throw new Error('at least one corpus-bound output is required');
	if (new Set(outputs.map((output) => output.outputPath)).size !== outputs.length) {
		throw new Error('corpus-bound output paths must be unique');
	}
	const initialCorpus = loadCorpus(manifestPath);
	let localCorpusRoot;
	let lockPath;
	let lockToken;
	let resultsRoot;
	if (initialCorpus.distribution === 'local') {
		localCorpusRoot = path.join(path.dirname(manifestPath), 'local-corpus');
		resultsRoot = path.join(path.dirname(manifestPath), 'results');
		for (const output of outputs) validateLocalOutputPath(resultsRoot, output.outputPath);
		lockPath = path.join(localCorpusRoot, '.intake.lock');
		lockToken = acquireLocalCorpusLock(lockPath, localCorpusRoot, manifestPath);
	}

	const stagedOutputs = outputs.map((output) => ({
		...output,
		stagedPath: `${output.outputPath}.tmp-${process.pid}-${randomUUID()}`,
	}));
	try {
		if (localCorpusRoot && hasPendingWithdrawal(localCorpusRoot)) {
			throw new Error('a corpus withdrawal is pending; refusing to write results until it is resumed');
		}
		const currentCorpus = loadCorpus(manifestPath);
		if (currentCorpus.corpus_fingerprint !== options.expectedFingerprint) {
			throw new Error('corpus changed while the benchmark was running; refusing to write stale results');
		}
		if (resultsRoot) {
			fs.mkdirSync(resultsRoot, { recursive: true });
			for (const output of outputs) validateLocalOutputPath(resultsRoot, output.outputPath);
		} else {
			for (const output of outputs) {
				fs.mkdirSync(path.dirname(output.outputPath), { recursive: true });
			}
		}
		for (const output of stagedOutputs) {
			fs.writeFileSync(output.stagedPath, output.contents, {
				mode: resultsRoot ? 0o600 : undefined,
			});
		}
		for (const output of stagedOutputs) fs.renameSync(output.stagedPath, output.outputPath);
	} finally {
		for (const output of stagedOutputs) fs.rmSync(output.stagedPath, { force: true });
		if (lockPath && lockToken) releaseLocalCorpusLock(lockPath, lockToken);
	}
}

export function writeCorpusBoundJson(options) {
	writeCorpusBoundFiles({
		manifestPath: options.manifestPath,
		expectedFingerprint: options.expectedFingerprint,
		outputs: [
			{
				outputPath: options.outputPath,
				contents: `${JSON.stringify(options.value, null, 2)}\n`,
			},
		],
	});
}
