#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateFinalizedPublicCorpus } from './public-corpus.ts';
import { acquirePublicCorpusLock, releasePublicCorpusLock } from './public-corpus-lock.ts';
import {
	DEFAULT_PUBLIC_CATALOG,
	DEFAULT_PUBLIC_SELECTION,
	DEFAULT_PUBLIC_WORKSPACE,
} from './public-corpus-prepare.ts';

export function parsePublicValidateArgs(args) {
	const options = {
		catalogPath: DEFAULT_PUBLIC_CATALOG,
		selectionPath: DEFAULT_PUBLIC_SELECTION,
		workspace: DEFAULT_PUBLIC_WORKSPACE,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		const value = () => {
			const next = args[index + 1];
			if (next === undefined || next.startsWith('--')) {
				throw new Error(`${argument} requires a value`);
			}
			index += 1;
			return next;
		};
		if (argument === '--catalog') {
			options.catalogPath = path.resolve(value());
		} else if (argument === '--selection') {
			options.selectionPath = path.resolve(value());
		} else if (argument === '--workspace') {
			options.workspace = path.resolve(value());
		} else if (argument === '--help') {
			options.help = true;
		} else {
			throw new Error(`unknown argument '${argument}'`);
		}
	}
	return options;
}

function usage() {
	return `Usage: nub app/scripts/eval/public-corpus-validate.ts [options]

Options:
  --catalog <path>       Source catalog
  --selection <path>     Deterministic selection
  --workspace <path>     Finalized public-corpus workspace
  --help                 Show this help
`;
}

function main() {
	let lock;
	try {
		const options = parsePublicValidateArgs(process.argv.slice(2));
		if (options.help) {
			process.stdout.write(usage());
			return;
		}
		lock = acquirePublicCorpusLock(options.workspace);
		const errors = validateFinalizedPublicCorpus(options);
		if (errors.length > 0) {
			throw new Error(`public corpus validation failed:\n- ${errors.join('\n- ')}`);
		}
		process.stdout.write(
			`Public corpus is valid: ${path.join(options.workspace, 'corpus-local.json')}\n`,
		);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	} finally {
		if (lock) releasePublicCorpusLock(lock);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main();
}
