import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
	acquireLocalCorpusLock,
	hasPendingWithdrawal,
	releaseLocalCorpusLock,
} from './corpus-intake.ts';
import { loadCorpus } from './corpus.ts';

const RESULT_TRANSACTION_PATTERN = /^\.result-transaction-(\d+)-([0-9a-f-]{36})\.json$/;

function processIsRunning(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== 'ESRCH';
	}
}

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

function writeTransactionMarker(markerPath, transaction) {
	const stagedMarker = `${markerPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		fs.writeFileSync(stagedMarker, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
		fs.renameSync(stagedMarker, markerPath);
	} finally {
		fs.rmSync(stagedMarker, { force: true });
	}
}

function isDirectFileName(value) {
	return (
		typeof value === 'string' &&
		value !== '.' &&
		value !== '..' &&
		path.basename(value) === value
	);
}

function readTransactionMarker(directory, entry) {
	const match = entry.name.match(RESULT_TRANSACTION_PATTERN);
	if (!match) return null;
	const markerPath = path.join(directory, entry.name);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`result transaction marker is not a regular file: ${markerPath}`);
	}
	let transaction;
	try {
		transaction = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to read result transaction ${markerPath}: ${error.message}`);
	}
	const pid = Number(match[1]);
	const token = match[2];
	if (
		transaction.schema_version !== 1 ||
		transaction.pid !== pid ||
		transaction.token !== token ||
		!['prepared', 'committed'].includes(transaction.state) ||
		!Array.isArray(transaction.outputs) ||
		transaction.outputs.length < 2
	) {
		throw new Error(`result transaction marker is invalid: ${markerPath}`);
	}
	const outputNames = new Set();
	for (const output of transaction.outputs) {
		if (
			!isDirectFileName(output.file) ||
			!isDirectFileName(output.staged_file) ||
			!output.staged_file.startsWith(`${output.file}.tmp-${pid}-`) ||
			!isDirectFileName(output.backup_file) ||
			output.backup_file !== `${output.file}.bak-${pid}-${token}` ||
			typeof output.had_original !== 'boolean' ||
			outputNames.has(output.file)
		) {
			throw new Error(`result transaction marker is invalid: ${markerPath}`);
		}
		outputNames.add(output.file);
	}
	return { markerPath, transaction };
}

function finishResultTransaction(directory, markerPath, transaction) {
	for (const output of transaction.outputs) {
		fs.rmSync(path.join(directory, output.staged_file), { force: true });
		fs.rmSync(path.join(directory, output.backup_file), { force: true });
	}
	fs.rmSync(markerPath, { force: true });
}

function rollBackResultTransaction(directory, markerPath, transaction) {
	for (const output of transaction.outputs) {
		const outputPath = path.join(directory, output.file);
		const backupPath = path.join(directory, output.backup_file);
		if (fs.existsSync(backupPath)) {
			fs.rmSync(outputPath, { force: true });
			fs.renameSync(backupPath, outputPath);
		} else if (!output.had_original) {
			fs.rmSync(outputPath, { force: true });
		}
		fs.rmSync(path.join(directory, output.staged_file), { force: true });
	}
	fs.rmSync(markerPath, { force: true });
}

function recoverResultTransactions(directory) {
	const directoryEntry = fs.lstatSync(directory, { throwIfNoEntry: false });
	if (!directoryEntry) return;
	if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
		throw new Error(`result output path is not a regular directory: ${directory}`);
	}
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const recovered = readTransactionMarker(directory, entry);
		if (!recovered) continue;
		if (processIsRunning(recovered.transaction.pid)) {
			throw new Error(`another result transaction is active: ${recovered.markerPath}`);
		}
		if (recovered.transaction.state === 'committed') {
			finishResultTransaction(directory, recovered.markerPath, recovered.transaction);
		} else {
			rollBackResultTransaction(directory, recovered.markerPath, recovered.transaction);
		}
	}
}

function promoteOutputSet(stagedOutputs) {
	const directory = path.dirname(stagedOutputs[0].outputPath);
	const token = randomUUID();
	const markerPath = path.join(directory, `.result-transaction-${process.pid}-${token}.json`);
	const transaction = {
		schema_version: 1,
		pid: process.pid,
		token,
		state: 'prepared',
		outputs: stagedOutputs.map((output) => {
			const existing = fs.lstatSync(output.outputPath, { throwIfNoEntry: false });
			if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
				throw new Error(`result output is not a regular file: ${output.outputPath}`);
			}
			const file = path.basename(output.outputPath);
			return {
				file,
				staged_file: path.basename(output.stagedPath),
				backup_file: `${file}.bak-${process.pid}-${token}`,
				had_original: Boolean(existing),
			};
		}),
	};
	writeTransactionMarker(markerPath, transaction);
	try {
		for (const output of transaction.outputs) {
			if (output.had_original) {
				fs.renameSync(
					path.join(directory, output.file),
					path.join(directory, output.backup_file),
				);
			}
		}
		for (const output of transaction.outputs) {
			fs.renameSync(
				path.join(directory, output.staged_file),
				path.join(directory, output.file),
			);
		}
		transaction.state = 'committed';
		writeTransactionMarker(markerPath, transaction);
	} catch (error) {
		rollBackResultTransaction(directory, markerPath, transaction);
		throw error;
	}
	finishResultTransaction(directory, markerPath, transaction);
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
	if (
		outputs.length > 1 &&
		new Set(outputs.map((output) => path.dirname(output.outputPath))).size !== 1
	) {
		throw new Error('corpus-bound output sets must share one directory');
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
		lockToken = acquireLocalCorpusLock(lockPath, localCorpusRoot, manifestPath, {
			operation: 'result-write',
		});
	}

	const stagedOutputs = outputs.map((output) => ({
		...output,
		stagedPath: `${output.outputPath}.tmp-${process.pid}-${randomUUID()}`,
	}));
	try {
		if (localCorpusRoot && hasPendingWithdrawal(localCorpusRoot)) {
			throw new Error('a corpus withdrawal is pending; refusing to write results until it is resumed');
		}
		if (resultsRoot) {
			fs.mkdirSync(resultsRoot, { recursive: true });
			for (const output of outputs) validateLocalOutputPath(resultsRoot, output.outputPath);
		} else {
			for (const output of outputs) {
				fs.mkdirSync(path.dirname(output.outputPath), { recursive: true });
			}
		}
		for (const directory of new Set(outputs.map((output) => path.dirname(output.outputPath)))) {
			recoverResultTransactions(directory);
		}
		const currentCorpus = loadCorpus(manifestPath);
		if (currentCorpus.corpus_fingerprint !== options.expectedFingerprint) {
			throw new Error('corpus changed while the benchmark was running; refusing to write stale results');
		}
		for (const output of stagedOutputs) {
			fs.writeFileSync(output.stagedPath, output.contents, {
				mode: resultsRoot ? 0o600 : 0o666,
			});
		}
		if (stagedOutputs.length === 1) {
			fs.renameSync(stagedOutputs[0].stagedPath, stagedOutputs[0].outputPath);
		} else {
			promoteOutputSet(stagedOutputs);
		}
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
