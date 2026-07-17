#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { preparedBundleForReview } from './corpus-prepared-bundle.ts';
import { recordConsentedReviewAttestation } from './corpus-review.ts';
import { REFERENCE_PROTOCOL_ID } from './corpus.ts';

function requiredValue(args, index, option) {
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
	return value;
}

export function parseAttestArgs(args, defaultManifestPath) {
	const options = {
		manifestPath: defaultManifestPath,
		acceptReviewedReference: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		if (option === '--accept-reviewed-reference') {
			options.acceptReviewedReference = true;
			continue;
		}
		const fields = {
			'--manifest': 'manifestPath',
			'--session-id': 'sessionId',
			'--reviewer': 'reviewerId',
			'--affirm-reference-protocol': 'affirmReferenceProtocol',
		};
		const field = fields[option];
		if (!field) throw new Error(`unknown option: ${option}`);
		options[field] = requiredValue(args, index, option);
		index += 1;
	}
	if (!options.sessionId) throw new Error('--session-id is required');
	if (!options.reviewerId) throw new Error('--reviewer is required');
	return options;
}

function usage() {
	return `Usage: nub app/scripts/eval/corpus-attest.ts [options]

Listen to the exact prepared recording and review its reference under
${REFERENCE_PROTOCOL_ID}. Each bundle requires two distinct reviewers.

Options:
  --manifest <path>          Local corpus manifest (default: corpus-local.json)
  --session-id <id>          Prepared opaque session ID
  --reviewer <opaque-id>     Lowercase reviewer identifier
  --accept-reviewed-reference
  --affirm-reference-protocol ${REFERENCE_PROTOCOL_ID}
`;
}

export function attestPreparedBundle(options) {
	const bundle = preparedBundleForReview({
		manifestPath: options.manifestPath,
		sessionId: options.sessionId,
	});
	return recordConsentedReviewAttestation({
		bundleDirectory: bundle.bundleDirectory,
		audioPath: bundle.audioPath,
		referencePath: bundle.referencePath,
		sessionId: bundle.metadata.sessionId,
		sampleId: bundle.metadata.sampleId,
		reviewerId: options.reviewerId,
		acceptReviewedReference: options.acceptReviewedReference,
		affirmReferenceProtocol: options.affirmReferenceProtocol,
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		if (process.argv.slice(2).includes('--help')) {
			process.stdout.write(usage());
		} else {
			const here = path.dirname(fileURLToPath(import.meta.url));
			const result = attestPreparedBundle(
				parseAttestArgs(process.argv.slice(2), path.join(here, 'corpus-local.json')),
			);
			if (result.invalidatedReviewCount > 0) {
				process.stdout.write(
					`Invalidated ${result.invalidatedReviewCount} stale review(s) after the prepared files changed.\n`,
				);
			}
			process.stdout.write(
				`Recorded review ${result.reviewCount}/2 by ${result.reviewerId}.\n` +
					`Audio ${result.audioSha256}; reference ${result.referenceSha256}.\n`,
			);
		}
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 2;
	}
}
