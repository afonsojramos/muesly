import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAttestArgs } from './corpus-attest.ts';
import {
	preparedBundleForReview,
	preparedBundleForWithdrawal,
	retirePreparedBundle,
} from './corpus-prepared-bundle.ts';
import {
	assertConsentedReviewAttestations,
	createConsentedReviewDirectory,
	recordConsentedReviewAttestation,
} from './corpus-review.ts';
import { REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { acquirePublicCorpusLock, releasePublicCorpusLock } from './public-corpus-lock.ts';

const supportedFileLinkKinds =
	process.platform === 'win32' ? ['hardlink'] : ['symlink', 'hardlink'];
const supportedDirectorySwapKinds =
	process.platform === 'win32' ? ['directory'] : ['symlink', 'directory'];

function fixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-corpus-review-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const sessionId = 'session-review-001';
	const sampleId = 'en-clean-review-001';
	const bundleDirectory = path.join(directory, 'intake', sessionId);
	const audioPath = path.join(bundleDirectory, 'recording.wav');
	const referencePath = path.join(bundleDirectory, 'reference.txt');
	fs.mkdirSync(bundleDirectory, { recursive: true, mode: 0o700 });
	fs.chmodSync(bundleDirectory, 0o700);
	fs.writeFileSync(audioPath, 'private reviewed audio', { mode: 0o600 });
	fs.writeFileSync(referencePath, 'Reviewed meeting reference.\n', { mode: 0o600 });
	const reviewAttestationsPath = createConsentedReviewDirectory(bundleDirectory);
	const context = { bundleDirectory, audioPath, referencePath, sessionId, sampleId };
	return {
		directory,
		manifestPath,
		bundleDirectory,
		audioPath,
		referencePath,
		reviewAttestationsPath,
		sessionId,
		sampleId,
		context,
	};
}

function attest(current, reviewerId, overrides = {}) {
	return recordConsentedReviewAttestation({
		...current.context,
		reviewerId,
		acceptReviewedReference: true,
		affirmReferenceProtocol: REFERENCE_PROTOCOL_ID,
		reviewedAt: '2026-07-17T12:00:00.000Z',
		...overrides,
	});
}

function writePreparedMetadata(current) {
	const consentRecordPath = path.join(current.directory, 'consent.md');
	fs.writeFileSync(consentRecordPath, 'affirmative consent record', { mode: 0o600 });
	fs.writeFileSync(
		path.join(current.bundleDirectory, 'collection-session.json'),
		`${JSON.stringify({
			schemaVersion: 3,
			referenceProtocolId: REFERENCE_PROTOCOL_ID,
			sessionId: current.sessionId,
			consentRecordId: 'consent-review-001',
			sampleId: current.sampleId,
			language: 'en',
			noiseCondition: 'clean',
			manifestPath: current.manifestPath,
			audioPath: current.audioPath,
			referencePath: current.referencePath,
			reviewAttestationsPath: current.reviewAttestationsPath,
			consentRecordPath,
		})}\n`,
		{ mode: 0o600 },
	);
}

test('attestation argument parsing requires values and explicit identifiers', () => {
	assert.throws(
		() => parseAttestArgs(['--session-id', '--reviewer', 'one'], 'manifest.json'),
		/--session-id requires a value/,
	);
	assert.throws(() => parseAttestArgs(['--unexpected'], 'manifest.json'), /unknown option/);
	assert.throws(() => parseAttestArgs([], 'manifest.json'), /--session-id is required/);
	assert.deepEqual(
		parseAttestArgs(
			['--session-id', 'session-one', '--reviewer', 'reviewer-one', '--accept-reviewed-reference'],
			'manifest.json',
		),
		{
			manifestPath: 'manifest.json',
			sessionId: 'session-one',
			reviewerId: 'reviewer-one',
			acceptReviewedReference: true,
		},
	);
});

test('records exactly two distinct immutable hash-bound reviews', () => {
	const current = fixture();
	assert.throws(
		() =>
			recordConsentedReviewAttestation({
				...current.context,
				reviewerId: 'reviewer-one',
				affirmReferenceProtocol: REFERENCE_PROTOCOL_ID,
			}),
		/accept-reviewed-reference/,
	);
	assert.throws(() => attest(current, 'UPPERCASE'), /opaque lowercase identifier/);
	const first = attest(current, 'reviewer-one');
	const second = attest(current, 'reviewer-two');
	assert.equal(first.reviewCount, 1);
	assert.equal(second.reviewCount, 2);
	assert.equal(first.audioSha256, second.audioSha256);
	assert.equal(first.referenceSha256, second.referenceSha256);
	assert.equal(fs.readdirSync(current.reviewAttestationsPath).length, 2);
	assert.deepEqual(assertConsentedReviewAttestations(current.context), {
		audioSha256: first.audioSha256,
		referenceSha256: first.referenceSha256,
		reviewerCount: 2,
	});
	for (const filename of fs.readdirSync(current.reviewAttestationsPath)) {
		assert.match(filename, /^[a-f0-9]{64}\.json$/);
		if (process.platform !== 'win32') {
			assert.equal(
				fs.statSync(path.join(current.reviewAttestationsPath, filename)).mode & 0o777,
				0o600,
			);
		}
	}
	assert.throws(() => attest(current, 'reviewer-two'), /already attested/);
	assert.throws(() => attest(current, 'reviewer-three'), /already has two accepted reviews/);
});

test('blocks zero, one, and stale reviews while supporting a full re-review after edits', () => {
	const current = fixture();
	assert.throws(
		() => assertConsentedReviewAttestations(current.context),
		/exactly 2 current review attestations; found 0/,
	);
	attest(current, 'reviewer-one');
	assert.throws(
		() => assertConsentedReviewAttestations(current.context),
		/exactly 2 current review attestations; found 1/,
	);
	fs.writeFileSync(current.referencePath, 'Corrected reviewed meeting reference.\n');
	assert.throws(
		() => assertConsentedReviewAttestations(current.context),
		/stale because the audio or reference changed/,
	);
	const restarted = attest(current, 'reviewer-two');
	assert.equal(restarted.invalidatedReviewCount, 1);
	assert.equal(restarted.reviewCount, 1);
	attest(current, 'reviewer-one');
	assert.equal(assertConsentedReviewAttestations(current.context).reviewerCount, 2);
});

test('rejects linked inputs and linked or misnamed review records', () => {
	for (const kind of supportedFileLinkKinds) {
		const current = fixture();
		const originalReference = current.referencePath;
		const linkedReference = path.join(current.bundleDirectory, `linked-${kind}.txt`);
		if (kind === 'symlink') fs.symlinkSync(originalReference, linkedReference);
		else fs.linkSync(originalReference, linkedReference);
		assert.throws(
			() => attest(current, 'reviewer-one', { referencePath: linkedReference }),
			/stable regular single-link file/,
			kind,
		);
	}

	const current = fixture();
	attest(current, 'reviewer-one');
	const [recordName] = fs.readdirSync(current.reviewAttestationsPath);
	const recordPath = path.join(current.reviewAttestationsPath, recordName);
	const aliasPath = path.join(current.reviewAttestationsPath, `${'f'.repeat(64)}.json`);
	fs.linkSync(recordPath, aliasPath);
	assert.throws(
		() => assertConsentedReviewAttestations(current.context),
		/stable regular single-link file/,
	);
});

test('rejects linked files at the generated prepared-bundle paths', () => {
	for (const kind of supportedFileLinkKinds) {
		const current = fixture();
		const externalReference = path.join(current.directory, `external-${kind}.txt`);
		fs.writeFileSync(externalReference, 'External reference.\n', { mode: 0o600 });
		fs.rmSync(current.referencePath);
		if (kind === 'symlink') fs.symlinkSync(externalReference, current.referencePath);
		else fs.linkSync(externalReference, current.referencePath);
		writePreparedMetadata(current);
		assert.throws(
			() =>
				preparedBundleForReview({
					manifestPath: current.manifestPath,
					sessionId: current.sessionId,
				}),
			/regular single-link file/,
			kind,
		);
	}
});

test('rejects prepared session path traversal', () => {
	const current = fixture();
	assert.throws(
		() =>
			preparedBundleForReview({
				manifestPath: current.manifestPath,
				sessionId: '../../outside',
			}),
		/opaque session-\* identifier/,
	);
});

test(
	'does not chmod a symlink target when securing the review directory',
	{
		skip: process.platform === 'win32',
	},
	() => {
		if (process.platform === 'win32') return;
		const current = fixture();
		fs.rmdirSync(current.reviewAttestationsPath);
		const outside = path.join(current.directory, 'outside-reviews');
		fs.mkdirSync(outside, { mode: 0o755 });
		fs.chmodSync(outside, 0o755);
		fs.symlinkSync(outside, current.reviewAttestationsPath, 'dir');
		assert.throws(
			() => createConsentedReviewDirectory(current.bundleDirectory),
			/must be stored in a real directory/,
		);
		assert.equal(fs.statSync(outside).mode & 0o777, 0o755);
	},
);

test('never trusts a replacement installed before the secured review directory is captured', () => {
	for (const kind of supportedDirectorySwapKinds) {
		const current = fixture();
		const displacedDirectory = path.join(current.bundleDirectory, `displaced-capture-${kind}`);
		const replacementDirectory = path.join(current.bundleDirectory, `replacement-capture-${kind}`);
		fs.mkdirSync(replacementDirectory, { mode: 0o700 });
		fs.writeFileSync(path.join(replacementDirectory, 'sentinel'), 'replacement sentinel', {
			mode: 0o600,
		});

		assert.throws(
			() =>
				attest(current, 'reviewer-one', {
					beforeReviewDirectoryCapture: ({ reviewDirectory }) => {
						fs.renameSync(reviewDirectory, displacedDirectory);
						if (kind === 'symlink') fs.symlinkSync(replacementDirectory, reviewDirectory, 'dir');
						else fs.renameSync(replacementDirectory, reviewDirectory);
					},
				}),
			/review attestations.*(?:changed|real directory)/,
			kind,
		);

		const installedDirectory =
			kind === 'symlink' ? replacementDirectory : current.reviewAttestationsPath;
		assert.deepEqual(fs.readdirSync(installedDirectory), ['sentinel'], kind);
		assert.deepEqual(fs.readdirSync(displacedDirectory), [], kind);
	}
});

test('never retires a replacement installed after prepared-bundle validation', () => {
	const current = fixture();
	writePreparedMetadata(current);
	const prepared = preparedBundleForReview({
		manifestPath: current.manifestPath,
		sessionId: current.sessionId,
	});
	const displaced = `${current.bundleDirectory}-displaced`;
	const replacementMarker = path.join(current.bundleDirectory, 'replacement.txt');
	assert.throws(
		() =>
			retirePreparedBundle(prepared, {
				beforeRetireClaim: ({ bundleDirectory }) => {
					fs.renameSync(bundleDirectory, displaced);
					fs.mkdirSync(bundleDirectory, { mode: 0o700 });
					fs.writeFileSync(replacementMarker, 'must survive');
				},
			}),
		/changed before retirement/,
	);
	assert.equal(fs.readFileSync(replacementMarker, 'utf8'), 'must survive');
	assert(fs.existsSync(displaced));
	assert(
		!fs.existsSync(
			path.join(path.dirname(current.bundleDirectory), `.retired-${current.sessionId}`),
		),
	);
});

test('never retires through a replaced intake-root ancestor', () => {
	const current = fixture();
	writePreparedMetadata(current);
	const prepared = preparedBundleForReview({
		manifestPath: current.manifestPath,
		sessionId: current.sessionId,
	});
	const intakeRoot = path.dirname(current.bundleDirectory);
	const displacedRoot = `${intakeRoot}-displaced`;
	assert.throws(
		() =>
			retirePreparedBundle(prepared, {
				beforeRetireClaim: () => {
					fs.renameSync(intakeRoot, displacedRoot);
					fs.mkdirSync(intakeRoot, { mode: 0o700 });
				},
			}),
		/review lock parent changed|changed before retirement/,
	);
	assert(fs.existsSync(path.join(displacedRoot, current.sessionId)));
	assert(fs.statSync(intakeRoot).isDirectory());
});

test('preserves a replacement installed at an active retirement claim', () => {
	const current = fixture();
	writePreparedMetadata(current);
	const prepared = preparedBundleForReview({
		manifestPath: current.manifestPath,
		sessionId: current.sessionId,
	});
	const claimDirectory = path.join(
		path.dirname(prepared.bundleDirectory),
		`.retired-${current.sessionId}`,
	);
	const displacedClaim = `${claimDirectory}-displaced`;
	const replacementMarker = path.join(claimDirectory, 'replacement.txt');
	assert.throws(
		() =>
			retirePreparedBundle(prepared, {
				beforeRetiredBundleDelete: ({ claimDirectory: claimed }) => {
					assert.equal(claimed, claimDirectory);
					fs.renameSync(claimed, displacedClaim);
					fs.mkdirSync(claimed, { mode: 0o700 });
					fs.writeFileSync(replacementMarker, 'must survive');
				},
			}),
		/retired prepared intake bundle claim changed before retirement/,
	);
	assert.equal(fs.readFileSync(replacementMarker, 'utf8'), 'must survive');
	assert(fs.existsSync(displacedClaim));
	assert(!fs.existsSync(current.bundleDirectory));
});

test('recovers an identity-claimed prepared bundle after interrupted deletion', () => {
	const current = fixture();
	writePreparedMetadata(current);
	const prepared = preparedBundleForReview({
		manifestPath: current.manifestPath,
		sessionId: current.sessionId,
	});
	const claimDirectory = path.join(
		path.dirname(prepared.bundleDirectory),
		`.retired-${current.sessionId}`,
	);
	assert.throws(
		() =>
			retirePreparedBundle(prepared, {
				beforeRetiredBundleDelete: () => {
					throw new Error('injected retirement interruption');
				},
			}),
		/injected retirement interruption/,
	);
	assert(!fs.existsSync(current.bundleDirectory));
	assert(fs.existsSync(claimDirectory));
	const recoverable = preparedBundleForWithdrawal(current.manifestPath, current.sessionId);
	assert.equal(recoverable.retired, true);
	assert.equal(retirePreparedBundle(recoverable), true);
	assert(!fs.existsSync(claimDirectory));
});

test('preserves a replacement installed at a recovered retirement claim', () => {
	const current = fixture();
	writePreparedMetadata(current);
	const prepared = preparedBundleForReview({
		manifestPath: current.manifestPath,
		sessionId: current.sessionId,
	});
	const claimDirectory = path.join(
		path.dirname(prepared.bundleDirectory),
		`.retired-${current.sessionId}`,
	);
	assert.throws(
		() =>
			retirePreparedBundle(prepared, {
				beforeRetiredBundleDelete: () => {
					throw new Error('injected retirement interruption');
				},
			}),
		/injected retirement interruption/,
	);
	const recoverable = preparedBundleForWithdrawal(current.manifestPath, current.sessionId);
	const displacedClaim = `${claimDirectory}-displaced`;
	const replacementMarker = path.join(claimDirectory, 'replacement.txt');
	assert.throws(
		() =>
			retirePreparedBundle(recoverable, {
				beforeRetiredBundleDelete: ({ claimDirectory: claimed }) => {
					assert.equal(claimed, claimDirectory);
					fs.renameSync(claimed, displacedClaim);
					fs.mkdirSync(claimed, { mode: 0o700 });
					fs.writeFileSync(replacementMarker, 'must survive');
				},
			}),
		/retired prepared intake bundle changed before retirement/,
	);
	assert.equal(fs.readFileSync(replacementMarker, 'utf8'), 'must survive');
	assert(fs.existsSync(displacedClaim));
});

test('detects input replacement during attestation and removes only its failed record', () => {
	const current = fixture();
	assert.throws(
		() =>
			attest(current, 'reviewer-one', {
				beforeReviewWrite: ({ referencePath }) => {
					fs.writeFileSync(referencePath, 'Changed during review publication.\n');
				},
			}),
		/changed while it was being reviewed/,
	);
	assert.deepEqual(fs.readdirSync(current.reviewAttestationsPath), []);
});

test('recovers interrupted no-clobber review publication', () => {
	const current = fixture();
	attest(current, 'reviewer-one');
	const [reviewName] = fs.readdirSync(current.reviewAttestationsPath);
	const reviewPath = path.join(current.reviewAttestationsPath, reviewName);
	const pendingPublished = path.join(
		current.reviewAttestationsPath,
		`.pending-${path.basename(reviewName, '.json')}-${randomUUID()}.json`,
	);
	fs.renameSync(reviewPath, pendingPublished);
	fs.linkSync(pendingPublished, reviewPath);
	const abandonedPending = path.join(
		current.reviewAttestationsPath,
		`.pending-${'f'.repeat(64)}-${randomUUID()}.json`,
	);
	fs.writeFileSync(abandonedPending, '{"interrupted":', { mode: 0o600 });

	attest(current, 'reviewer-two');

	const names = fs.readdirSync(current.reviewAttestationsPath);
	assert.equal(names.length, 2);
	assert(names.every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
	assert.equal(fs.statSync(reviewPath).nlink, 1);
	assert.equal(assertConsentedReviewAttestations(current.context).reviewerCount, 2);
});

test('never recovers pending publications through a replaced review directory', () => {
	for (const kind of supportedDirectorySwapKinds) {
		const current = fixture();
		const pendingName = `.pending-${'f'.repeat(64)}-${randomUUID()}.json`;
		const originalPending = path.join(current.reviewAttestationsPath, pendingName);
		fs.writeFileSync(originalPending, 'original pending review', { mode: 0o600 });
		const displacedDirectory = path.join(current.bundleDirectory, `displaced-recovery-${kind}`);
		const replacementDirectory = path.join(current.bundleDirectory, `replacement-recovery-${kind}`);
		fs.mkdirSync(replacementDirectory, { mode: 0o700 });
		const replacementPending = path.join(replacementDirectory, pendingName);
		fs.writeFileSync(replacementPending, 'replacement pending review', { mode: 0o600 });

		assert.throws(
			() =>
				assertConsentedReviewAttestations({
					...current.context,
					beforeReviewRecoveryMutation: ({ reviewDirectory }) => {
						fs.renameSync(reviewDirectory, displacedDirectory);
						if (kind === 'symlink') fs.symlinkSync(replacementDirectory, reviewDirectory, 'dir');
						else fs.renameSync(replacementDirectory, reviewDirectory);
					},
				}),
			/review attestations.*(?:changed|real directory)/,
			kind,
		);

		const installedDirectory =
			kind === 'symlink' ? replacementDirectory : current.reviewAttestationsPath;
		assert.equal(
			fs.readFileSync(path.join(installedDirectory, pendingName), 'utf8'),
			'replacement pending review',
			kind,
		);
		assert.equal(
			fs.readFileSync(path.join(displacedDirectory, pendingName), 'utf8'),
			'original pending review',
			kind,
		);
	}
});

test('never publishes a review through a replaced review directory', () => {
	for (const kind of supportedDirectorySwapKinds) {
		const current = fixture();
		const displacedDirectory = path.join(current.bundleDirectory, `displaced-publication-${kind}`);
		const replacementDirectory = path.join(
			current.bundleDirectory,
			`replacement-publication-${kind}`,
		);
		fs.mkdirSync(replacementDirectory, { mode: 0o700 });
		fs.writeFileSync(path.join(replacementDirectory, 'sentinel'), 'replacement sentinel', {
			mode: 0o600,
		});

		assert.throws(
			() =>
				attest(current, 'reviewer-one', {
					beforeReviewWrite: ({ reviewDirectory }) => {
						fs.renameSync(reviewDirectory, displacedDirectory);
						if (kind === 'symlink') fs.symlinkSync(replacementDirectory, reviewDirectory, 'dir');
						else fs.renameSync(replacementDirectory, reviewDirectory);
					},
				}),
			/review attestations.*(?:changed|real directory)/,
			kind,
		);

		const installedDirectory =
			kind === 'symlink' ? replacementDirectory : current.reviewAttestationsPath;
		assert.deepEqual(fs.readdirSync(installedDirectory), ['sentinel'], kind);
		assert.deepEqual(fs.readdirSync(displacedDirectory), [], kind);
	}
});

test('rejects an in-place review record change after the coherent snapshot is read', () => {
	const current = fixture();
	attest(current, 'reviewer-one');
	attest(current, 'reviewer-two');
	assert.throws(
		() =>
			assertConsentedReviewAttestations({
				...current.context,
				beforeReviewSnapshotReattest: ({ reviewPaths }) => {
					const reviewPath = reviewPaths[0];
					const original = fs.readFileSync(reviewPath, 'utf8');
					fs.writeFileSync(reviewPath, original.replace('"accepted"', '"rejected"'));
				},
			}),
		/changed while it was being reviewed/,
	);
});

test('rejects unexpected membership added after the validation snapshot', () => {
	const current = fixture();
	attest(current, 'reviewer-one');
	attest(current, 'reviewer-two');
	assert.throws(
		() =>
			assertConsentedReviewAttestations({
				...current.context,
				beforeReviewSnapshotReattest: ({ reviewDirectory }) => {
					fs.writeFileSync(path.join(reviewDirectory, 'unexpected-entry'), 'unexpected', {
						mode: 0o600,
					});
				},
			}),
		/review attestations directory changed after its coherent snapshot/,
	);
});

test('rolls back a review when membership changes after its publication snapshot', () => {
	const current = fixture();
	attest(current, 'reviewer-one');
	assert.throws(
		() =>
			attest(current, 'reviewer-two', {
				beforePublishedReviewSnapshotReattest: ({ reviewDirectory }) => {
					fs.writeFileSync(path.join(reviewDirectory, 'unexpected-entry'), 'unexpected', {
						mode: 0o600,
					});
				},
			}),
		/review attestations directory changed after its coherent snapshot/,
	);
	assert.equal(
		fs
			.readdirSync(current.reviewAttestationsPath)
			.filter((filename) => /^[a-f0-9]{64}\.json$/.test(filename)).length,
		1,
	);
});

test('serializes two concurrent CLI reviewers without losing either record', async () => {
	const current = fixture();
	writePreparedMetadata(current);
	const scriptPath = fileURLToPath(new URL('./corpus-attest.ts', import.meta.url));
	const command = (reviewerId) =>
		spawn(
			'nub',
			[
				scriptPath,
				'--manifest',
				current.manifestPath,
				'--session-id',
				current.sessionId,
				'--reviewer',
				reviewerId,
				'--accept-reviewed-reference',
				'--affirm-reference-protocol',
				REFERENCE_PROTOCOL_ID,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
	const children = [command('reviewer-one'), command('reviewer-two')];
	const exits = await Promise.all(children.map((child) => once(child, 'exit')));
	assert.deepEqual(
		exits.map(([code]) => code),
		[0, 0],
	);
	assert.equal(assertConsentedReviewAttestations(current.context).reviewerCount, 2);
});

test('rejects lock names that could escape the bundle', () => {
	const current = fixture();
	assert.throws(
		() => acquirePublicCorpusLock(current.bundleDirectory, 0, { lockName: '../escape.lock' }),
		/safe .* basename/,
	);
	assert.equal(fs.existsSync(path.join(current.directory, 'intake', 'escape.lock')), false);
});

test('labels review-lock contention as review work', () => {
	const current = fixture();
	const lock = acquirePublicCorpusLock(current.directory, 30_000, {
		lockName: '.review-timeout.lock',
	});
	try {
		assert.throws(
			() =>
				acquirePublicCorpusLock(current.directory, 0, {
					lockName: '.review-timeout.lock',
					activity: 'review attestation',
				}),
			/timed out waiting for review attestation/,
		);
	} finally {
		assert.equal(releasePublicCorpusLock(lock), true);
	}
});
