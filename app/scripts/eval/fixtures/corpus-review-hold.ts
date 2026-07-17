#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
	assertConsentedReviewAttestations,
	recordConsentedReviewAttestation,
} from '../corpus-review.ts';
import { REFERENCE_PROTOCOL_ID } from '../corpus.ts';

const [configurationPath, enteredPath, releasePath] = process.argv.slice(2);
if (!configurationPath || !enteredPath || !releasePath) {
	throw new Error('configuration, entered, and release paths are required');
}

const configuration = JSON.parse(fs.readFileSync(configurationPath, 'utf8'));
const waitSignal = new Int32Array(new SharedArrayBuffer(4));
const holdReviewLock = () => {
	fs.writeFileSync(enteredPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
	const deadline = Date.now() + 30_000;
	while (!fs.existsSync(releasePath)) {
		if (
			configuration.releaseOnContention === true &&
			fs
				.readdirSync(path.dirname(path.dirname(configuration.bundleDirectory)))
				.some((name) => /^\.review-[a-f0-9]{64}\.lock\.pending-/.test(name))
		) {
			return;
		}
		if (Date.now() >= deadline) throw new Error('timed out waiting to release held review');
		Atomics.wait(waitSignal, 0, 0, 10);
	}
};

if (configuration.mode === 'validate') {
	assertConsentedReviewAttestations({
		...configuration,
		beforeReviewSnapshotReattest: holdReviewLock,
	});
} else {
	recordConsentedReviewAttestation({
		...configuration,
		acceptReviewedReference: true,
		affirmReferenceProtocol: REFERENCE_PROTOCOL_ID,
		reviewedAt: '2026-07-17T12:00:00.000Z',
		beforeReviewWrite: holdReviewLock,
	});
}
