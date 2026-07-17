#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { recordPublicReviewAttestation } from './public-corpus.ts';
import {
	DEFAULT_PUBLIC_CATALOG,
	DEFAULT_PUBLIC_SELECTION,
	DEFAULT_PUBLIC_WORKSPACE,
} from './public-corpus-prepare.ts';

export function parsePublicAttestArgs(args) {
	const options = {
		catalogPath: DEFAULT_PUBLIC_CATALOG,
		selectionPath: DEFAULT_PUBLIC_SELECTION,
		workspace: DEFAULT_PUBLIC_WORKSPACE,
		acceptReviewedReference: false,
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
		} else if (argument === '--sample') {
			options.sampleId = value();
		} else if (argument === '--reviewer') {
			options.reviewerId = value();
		} else if (argument === '--affirm-reference-protocol') {
			options.affirmReferenceProtocol = value();
		} else if (argument === '--accept-reviewed-reference') {
			options.acceptReviewedReference = true;
		} else if (argument === '--help') {
			options.help = true;
		} else {
			throw new Error(`unknown argument '${argument}'`);
		}
	}
	return options;
}

function usage() {
	return `Usage: nub app/scripts/eval/public-corpus-attest.ts [options]

Run only after listening to the exact generated sample and reviewing its reference
under ${REFERENCE_PROTOCOL_ID}. Each sample requires two distinct reviewers.

Options:
  --sample <id>              Prepared sample ID
  --reviewer <opaque-id>     Lowercase reviewer identifier
  --accept-reviewed-reference
  --affirm-reference-protocol ${REFERENCE_PROTOCOL_ID}
  --catalog <path>           Source catalog
  --selection <path>         Deterministic selection
  --workspace <path>         Prepared public-corpus workspace
  --help                     Show this help
`;
}

function main() {
	try {
		const options = parsePublicAttestArgs(process.argv.slice(2));
		if (options.help) {
			process.stdout.write(usage());
			return;
		}
		const result = recordPublicReviewAttestation(options);
		process.stdout.write(
			`Recorded review ${result.reviewCount}/2 for ${result.sampleId} by ${result.reviewerId}.\n` +
				`Audio ${result.audioSha256}; reference ${result.referenceSha256}.\n`,
		);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main();
}
