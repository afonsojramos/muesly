#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PUBLIC_REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { finalizePublicCorpus } from './public-corpus.ts';
import {
	DEFAULT_PUBLIC_CATALOG,
	DEFAULT_PUBLIC_SELECTION,
	DEFAULT_PUBLIC_WORKSPACE,
} from './public-corpus-prepare.ts';

function parseNonNegativeNumber(value, flag) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} must be non-negative`);
	return number;
}

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
		} else if (argument === '--minimum-free-gib') {
			options.minimumFreeBytes = Math.floor(
				parseNonNegativeNumber(value(), '--minimum-free-gib') * 1024 ** 3,
			);
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

Finalization rederives every generated file from pinned public sources and requires
the exact human-reference bytes derived from them before creating corpus-local.json.

Options:
  --catalog <path>           Source catalog
  --selection <path>         Deterministic selection
  --workspace <path>         Prepared public-corpus workspace
  --minimum-free-gib <GiB>   Override the 20 GiB reconstruction reserve
  --affirm-reference-protocol ${PUBLIC_REFERENCE_PROTOCOL_ID}
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
			`Finalized ${result.sampleCount} verified public upstream-gold ASR samples at ${result.manifestPath}.\n`,
		);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main();
}
