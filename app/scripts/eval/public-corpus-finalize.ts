#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { finalizePublicCorpus } from './public-corpus.ts';
import {
	DEFAULT_PUBLIC_CATALOG,
	DEFAULT_PUBLIC_SELECTION,
	DEFAULT_PUBLIC_WORKSPACE,
} from './public-corpus-prepare.ts';

export function parsePublicFinalizeArgs(args) {
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
		} else if (argument === '--affirm-reference-protocol') {
			options.affirmReferenceProtocol = value();
		} else if (argument === '--help') {
			options.help = true;
		} else {
			throw new Error(`unknown argument '${argument}'`);
		}
	}
	return options;
}

function usage() {
	return `Usage: nub app/scripts/eval/public-corpus-finalize.ts [options]

Finalization verifies every generated file and requires two distinct, accepted,
hash-bound reviews for every reference before creating corpus-local.json.

Options:
  --catalog <path>           Source catalog
  --selection <path>         Deterministic selection
  --workspace <path>         Prepared public-corpus workspace
  --affirm-reference-protocol ${REFERENCE_PROTOCOL_ID}
  --help                     Show this help
`;
}

async function main() {
	try {
		const options = parsePublicFinalizeArgs(process.argv.slice(2));
		if (options.help) {
			process.stdout.write(usage());
			return;
		}
		const result = await finalizePublicCorpus(options);
		process.stdout.write(
			`Finalized ${result.sampleCount} reviewed public ASR samples at ${result.manifestPath}.\n`,
		);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main();
}
