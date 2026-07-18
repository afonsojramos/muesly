import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fileSha256, PUBLIC_REFERENCE_PROTOCOL_ID, REFERENCE_PROTOCOL_ID } from './corpus.ts';
import {
	acquirePreparationLock,
	assertWorkspaceIsUntracked,
	calculatePreparationDiskRequirement,
	groupAmiSamplesByReferenceArchive,
	noiseGainForSnr,
	parsePublicPrepareArgs,
	publishExtractedDirectory,
	publishNoClobber,
	releasePreparationLock,
	writeDraftReference,
	writePinnedReference,
} from './public-corpus-prepare.ts';
import { parsePublicAttestArgs } from './public-corpus-attest.ts';
import { parsePublicFinalizeArgs } from './public-corpus-finalize.ts';
import { parsePublicValidateArgs } from './public-corpus-validate.ts';
import {
	atomicWriteJson,
	createReviewTemplate,
	deriveEarningsReferenceExcerpt,
	downloadPinnedArtifact,
	EARNINGS_MAX_ADJACENT_OVERLAP_SECONDS,
	EARNINGS_MAX_START_REGRESSION_SECONDS,
	ensurePrivateDirectory,
	expectedPublicSampleIds,
	extractArchiveMembers,
	finalizePublicCorpus,
	listArchiveEntries,
	loadPublicCorpusConfig,
	parseAmiWordDocuments,
	parseEarningsTimedHypothesis,
	parseFleursTsv,
	planOverlapTimings,
	PUBLIC_PREPARED_SCHEMA_VERSION,
	PUBLIC_REFERENCE_RECIPES,
	PUBLIC_REVIEW_SCHEMA_VERSION,
	PUBLIC_SOURCE_CATALOG_ID,
	readPinnedArtifactFile,
	recordPublicReviewAttestation,
	renderTimedReference,
	selectDensestTimedWindow,
	selectFleursComposites,
	sha256Text,
	validateArchiveEntries,
	validateArchiveMemberPaths,
	validateFinalizedPublicCorpus,
	validatePublicSelection,
	validateSourceCatalog,
	withPinnedArtifactPath,
	writePreparedBundle,
} from './public-corpus.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(here, 'public-corpus-sources.json');
const selectionPath = path.join(here, 'public-corpus-selection.json');

function temporaryDirectory(prefix = 'muesly-public-corpus-') {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('committed public source pins and deterministic selection are internally complete', () => {
	const { catalog, selection } = loadPublicCorpusConfig(catalogPath, selectionPath);
	assert.equal(catalog.schema_version, 3);
	assert.equal(catalog.catalog_id, 'muesly-public-asr-sources-v3');
	assert.equal(selection.schema_version, 3);
	assert.equal(selection.corpus_id, 'muesly-public-asr-v2');
	assert.equal(catalog.artifacts.length, 23);
	assert.equal(catalog.sources.length, 11);
	const alignmentArtifacts = catalog.artifacts.filter(
		(artifact) => artifact.kind === 'alignment-hypothesis',
	);
	assert.equal(alignmentArtifacts.length, 3);
	assert(
		alignmentArtifacts.every(
			(artifact) =>
				artifact.revision === 'c05ab6fd8b4b627d123c922a22a39e993dd37635' &&
				artifact.role === 'timing-only',
		),
	);
	assert.deepEqual(
		new Set(catalog.sources.map((source) => source.reference_verification)),
		new Set(Object.values(PUBLIC_REFERENCE_RECIPES)),
	);
	const earningsReferences = catalog.artifacts.filter(
		(artifact) => artifact.kind === 'reference' && artifact.id.startsWith('earnings21-'),
	);
	const earningsRevision = 'c05ab6fd8b4b627d123c922a22a39e993dd37635';
	assert.deepEqual(
		earningsReferences.map((artifact) => [artifact.id, artifact.revision, artifact.url]),
		['4320211', '4330115', '4341191'].map((sourceId) => [
			`earnings21-${sourceId}-reference`,
			earningsRevision,
			`https://raw.githubusercontent.com/revdotcom/speech-datasets/${earningsRevision}/earnings21/transcripts/nlp_references/${sourceId}.nlp`,
		]),
	);
	const missingAlignmentRevision = structuredClone(catalog);
	delete missingAlignmentRevision.artifacts.find(
		(artifact) => artifact.kind === 'alignment-hypothesis',
	).revision;
	assert.match(
		validateSourceCatalog(missingAlignmentRevision).join('\n'),
		/revision must be a non-empty trimmed string/,
	);
	assert.equal(expectedPublicSampleIds(selection).length, 66);
	assert.equal(new Set(expectedPublicSampleIds(selection)).size, 66);
	assert.equal(selection.fleurs.inter_utterance_gap_seconds, 0.4);
	const missingPins = structuredClone(selection);
	delete missingPins.fleurs.sources[0].composites[0].audio_sha256['clean-read'];
	delete missingPins.fleurs.sources[0].composites[0].reference_sha256;
	delete missingPins.natural_samples[0].audio_sha256;
	delete missingPins.natural_samples[0].reference_sha256;
	const missingPinErrors = validatePublicSelection(missingPins, catalog).join('\n');
	assert.match(missingPinErrors, /audio_sha256\.clean-read must be a non-placeholder/);
	assert.match(missingPinErrors, /composites\[0\]\.reference_sha256 must be a non-placeholder/);
	assert.match(missingPinErrors, /natural_samples\[0\]\.audio_sha256 must be a non-placeholder/);
	assert.match(missingPinErrors, /natural_samples\[0\]\.reference_sha256 must pin/);
	const mismatchedEarningsReference = structuredClone(selection);
	mismatchedEarningsReference.natural_samples.find((sample) =>
		sample.source_id.startsWith('earnings21-'),
	).reference_sha256 = '0123456789abcdef'.repeat(4);
	assert.match(
		validatePublicSelection(mismatchedEarningsReference, catalog).join('\n'),
		/reference_sha256 must match window\.expected_reference_seed_sha256/,
	);
	assert.deepEqual(
		{
			fleurs:
				selection.fleurs.sources.length *
				selection.fleurs.composites_per_language *
				selection.fleurs.conditions.length,
			ami: selection.natural_samples.filter((sample) => sample.source_id.startsWith('ami-')).length,
			earnings21: selection.natural_samples.filter((sample) =>
				sample.source_id.startsWith('earnings21-'),
			).length,
		},
		{ fleurs: 60, ami: 3, earnings21: 3 },
	);
	assert.deepEqual(
		selection.natural_samples
			.filter((sample) => sample.source_id.startsWith('earnings21-'))
			.map((sample) => [
				sample.source_item_id,
				{
					strategy: sample.window.strategy,
					start_seconds: sample.window.start_seconds,
					alignment_context_seconds: sample.window.alignment_context_seconds,
					alignment_hypothesis_tokens: sample.window.expected_alignment_hypothesis_tokens,
					alignment_reference_tokens: sample.window.expected_alignment_reference_tokens,
					alignment_edit_distance: sample.window.expected_alignment_edit_distance,
					alignment_paired_tokens: sample.window.expected_alignment_paired_tokens,
					alignment_exact_pairs: sample.window.expected_alignment_exact_pairs,
					reference_start_token_index: sample.window.expected_reference_start_token_index,
					reference_end_token_index: sample.window.expected_reference_end_token_index,
					reference_token_count: sample.window.expected_reference_token_count,
					anchor_context_tokens: sample.window.expected_anchor_context_tokens,
					start_anchor_hypothesis_token_index:
						sample.window.expected_start_anchor_hypothesis_token_index,
					start_anchor_start_seconds: sample.window.expected_start_anchor_start_seconds,
					start_anchor_end_seconds: sample.window.expected_start_anchor_end_seconds,
					start_anchor_context_sha256: sample.window.expected_start_anchor_context_sha256,
					end_anchor_hypothesis_token_index:
						sample.window.expected_end_anchor_hypothesis_token_index,
					end_anchor_start_seconds: sample.window.expected_end_anchor_start_seconds,
					end_anchor_end_seconds: sample.window.expected_end_anchor_end_seconds,
					end_anchor_context_sha256: sample.window.expected_end_anchor_context_sha256,
					reference_seed_sha256: sample.window.expected_reference_seed_sha256,
					reference_sha256: sample.reference_sha256,
				},
			]),
		[
			[
				'earnings21:4320211',
				{
					strategy: 'fixed',
					start_seconds: 60,
					alignment_context_seconds: 30,
					alignment_hypothesis_tokens: 697,
					alignment_reference_tokens: 681,
					alignment_edit_distance: 62,
					alignment_paired_tokens: 678,
					alignment_exact_pairs: 638,
					reference_start_token_index: 159,
					reference_end_token_index: 603,
					reference_token_count: 445,
					anchor_context_tokens: 2,
					start_anchor_hypothesis_token_index: 167,
					start_anchor_start_seconds: 62.03,
					start_anchor_end_seconds: 62.21,
					start_anchor_context_sha256:
						'eb3eb3e4b66cbe2ba6b59473991f8e7dec5c5c5c368823b1253ecea30081cf93',
					end_anchor_hypothesis_token_index: 613,
					end_anchor_start_seconds: 238.99,
					end_anchor_end_seconds: 239.53,
					end_anchor_context_sha256:
						'9e0f88feb31951d1c10272cf7d4450e762e84a427879f9be48947510a48227ea',
					reference_seed_sha256: '20dd94b992cff0bd5cb067de8e6d53fa2028c3c248be19b19ad1fee036069211',
					reference_sha256: '20dd94b992cff0bd5cb067de8e6d53fa2028c3c248be19b19ad1fee036069211',
				},
			],
			[
				'earnings21:4330115',
				{
					strategy: 'fixed',
					start_seconds: 60,
					alignment_context_seconds: 30,
					alignment_hypothesis_tokens: 703,
					alignment_reference_tokens: 694,
					alignment_edit_distance: 67,
					alignment_paired_tokens: 689,
					alignment_exact_pairs: 641,
					reference_start_token_index: 152,
					reference_end_token_index: 616,
					reference_token_count: 465,
					anchor_context_tokens: 2,
					start_anchor_hypothesis_token_index: 156,
					start_anchor_start_seconds: 60.33,
					start_anchor_end_seconds: 60.51,
					start_anchor_context_sha256:
						'ace2000c45af6a9f55d0eca72d0665dbcd9acfdb5b1352ce18fe589c1f1ddcc4',
					end_anchor_hypothesis_token_index: 624,
					end_anchor_start_seconds: 238.84,
					end_anchor_end_seconds: 239.26,
					end_anchor_context_sha256:
						'd508e5013603201bbe596c1537da80bb379b6080996982549bf829f3956d5dd6',
					reference_seed_sha256: '2d599dbc4df2cccce13bb7fd1df69f34d1815803e0ce0a091d7ff3e0c00db776',
					reference_sha256: '2d599dbc4df2cccce13bb7fd1df69f34d1815803e0ce0a091d7ff3e0c00db776',
				},
			],
			[
				'earnings21:4341191',
				{
					strategy: 'fixed',
					start_seconds: 60,
					alignment_context_seconds: 30,
					alignment_hypothesis_tokens: 704,
					alignment_reference_tokens: 695,
					alignment_edit_distance: 42,
					alignment_paired_tokens: 694,
					alignment_exact_pairs: 663,
					reference_start_token_index: 174,
					reference_end_token_index: 628,
					reference_token_count: 455,
					anchor_context_tokens: 2,
					start_anchor_hypothesis_token_index: 178,
					start_anchor_start_seconds: 60.18,
					start_anchor_end_seconds: 60.36,
					start_anchor_context_sha256:
						'2957a1ea411b7772421c44e5bd704fd25daf1d48ec5d48cd88ee444ec7cd0064',
					end_anchor_hypothesis_token_index: 637,
					end_anchor_start_seconds: 238.93,
					end_anchor_end_seconds: 239.65,
					end_anchor_context_sha256:
						'04555da5583aebb71550e28aa11d5532d3ae313bdd783697f8e7a74eaa6d4775',
					reference_seed_sha256: '68867517f725b954e7d9940b47c2d137b7aa48049374aad15e140980d37f65ea',
					reference_sha256: '68867517f725b954e7d9940b47c2d137b7aa48049374aad15e140980d37f65ea',
				},
			],
		],
	);
});

test('public source reference recipes are closed and bind the exact artifact roles', () => {
	const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

	const missingRecipe = structuredClone(catalog);
	delete missingRecipe.sources[0].reference_verification;
	assert.match(
		validateSourceCatalog(missingRecipe).join('\n'),
		/reference_verification is not a supported closed recipe/,
	);

	const unknownRecipe = structuredClone(catalog);
	unknownRecipe.sources[0].reference_verification = 'trust-whatever-is-there-v1';
	assert.match(
		validateSourceCatalog(unknownRecipe).join('\n'),
		/reference_verification is not a supported closed recipe/,
	);

	const wrongRecipe = structuredClone(catalog);
	wrongRecipe.sources[0].reference_verification = PUBLIC_REFERENCE_RECIPES.AMI;
	assert.match(
		validateSourceCatalog(wrongRecipe).join('\n'),
		/dataset is incompatible|artifact_ids must contain exactly/,
	);

	const wrongArtifactKinds = structuredClone(catalog);
	const fleursIndexId = wrongArtifactKinds.sources[0].artifact_ids.find(
		(artifactId) =>
			wrongArtifactKinds.artifacts.find((artifact) => artifact.id === artifactId).kind === 'index',
	);
	wrongArtifactKinds.artifacts.find((artifact) => artifact.id === fleursIndexId).kind = 'audio';
	assert.match(
		validateSourceCatalog(wrongArtifactKinds).join('\n'),
		/artifact_ids must contain exactly audio-archive, index/,
	);

	const nonTimingAlignment = structuredClone(catalog);
	delete nonTimingAlignment.artifacts.find((artifact) => artifact.kind === 'alignment-hypothesis')
		.role;
	const nonTimingErrors = validateSourceCatalog(nonTimingAlignment).join('\n');
	assert.match(nonTimingErrors, /role must be timing-only/);
	assert.match(nonTimingErrors, /must bind a timing-only alignment hypothesis/);
});

test('public source catalog identity, licenses, and revisions are closed production inputs', () => {
	const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
	const wrongCatalogId = structuredClone(catalog);
	wrongCatalogId.catalog_id = 'muesly-public-asr-sources-custom';
	assert.match(
		validateSourceCatalog(wrongCatalogId).join('\n'),
		new RegExp(`catalog_id must be '${PUBLIC_SOURCE_CATALOG_ID}'`),
	);

	for (const recipe of Object.values(PUBLIC_REFERENCE_RECIPES)) {
		const sourceIndex = catalog.sources.findIndex(
			(source) => source.reference_verification === recipe,
		);
		for (const [field, replacement] of [
			['license_id', 'not-a-vetted-license'],
			['license_url', 'https://example.invalid/license'],
			['revision', 'unreviewed-revision'],
		]) {
			const mutated = structuredClone(catalog);
			mutated.sources[sourceIndex][field] = replacement;
			assert.match(
				validateSourceCatalog(mutated).join('\n'),
				new RegExp(`${field} must be .* for ${recipe}`),
			);
		}
	}
});

test('natural sample identities and recording-specific artifacts cannot cross recordings', () => {
	const { catalog, selection } = loadPublicCorpusConfig(catalogPath, selectionPath);
	for (const sourcePrefix of ['ami-', 'earnings21-']) {
		const crossed = structuredClone(selection);
		const samples = crossed.natural_samples.filter((sample) => sample.source_id.startsWith(sourcePrefix));
		samples[0].source_item_id = samples[1].source_item_id;
		assert.match(
			validatePublicSelection(crossed, catalog).join('\n'),
			/source_item_id must identify the (meeting|recording) bound by source_id/,
		);
	}

	const crossedAmiAudio = structuredClone(catalog);
	const amiSources = crossedAmiAudio.sources.filter(
		(source) => source.reference_verification === PUBLIC_REFERENCE_RECIPES.AMI,
	);
	const firstAmiAudio = amiSources[0].artifact_ids.find((id) => id.endsWith('-headset-mix'));
	const secondAmiAudio = amiSources[1].artifact_ids.find((id) => id.endsWith('-headset-mix'));
	amiSources[0].artifact_ids = amiSources[0].artifact_ids.map((id) =>
		id === firstAmiAudio ? secondAmiAudio : id,
	);
	amiSources[1].artifact_ids = amiSources[1].artifact_ids.map((id) =>
		id === secondAmiAudio ? firstAmiAudio : id,
	);
	assert.match(
		validateSourceCatalog(crossedAmiAudio).join('\n'),
		/must bind its AMI meeting id to its headset-mix artifact/,
	);

	const crossedEarningsReference = structuredClone(catalog);
	const earningsSources = crossedEarningsReference.sources.filter(
		(source) => source.reference_verification === PUBLIC_REFERENCE_RECIPES.EARNINGS21,
	);
	const references = earningsSources.slice(0, 2).map((source) =>
		source.artifact_ids.find((id) => id.endsWith('-reference')),
	);
	for (const [index, source] of earningsSources.slice(0, 2).entries()) {
		source.artifact_ids = source.artifact_ids.map((id) =>
			id === references[index] ? references[1 - index] : id,
		);
	}
	assert.match(
		validateSourceCatalog(crossedEarningsReference).join('\n'),
		/must bind its Earnings-21 recording id to its reference artifact/,
	);
});

test('AMI preparation groups each source by its catalog-bound reference archive', () => {
	const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
	const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
	const originalArtifactId = 'ami-manual-annotations-v1-6-2';
	const remappedArtifactId = 'ami-reviewed-annotations-remapped';
	const annotation = catalog.artifacts.find((artifact) => artifact.id === originalArtifactId);
	annotation.id = remappedArtifactId;
	for (const source of catalog.sources.filter(
		(candidate) => candidate.reference_verification === PUBLIC_REFERENCE_RECIPES.AMI,
	)) {
		source.artifact_ids = source.artifact_ids.map((id) =>
			id === originalArtifactId ? remappedArtifactId : id,
		);
	}
	assert.deepEqual(validateSourceCatalog(catalog), []);
	const groups = groupAmiSamplesByReferenceArchive(
		selection.natural_samples.filter((sample) => sample.source_id.startsWith('ami-')),
		catalog,
		'/tmp/remapped-public-corpus-cache',
	);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].annotationEntry.artifact.id, remappedArtifactId);
	assert.equal(groups[0].samples.length, 3);
	assert(groups[0].samples.every(({ source }) => source.artifact_ids.includes(remappedArtifactId)));
});

test('selection rejects weak committed Earnings alignment proof', () => {
	const { catalog, selection } = loadPublicCorpusConfig(catalogPath, selectionPath);
	const weakExactRatio = structuredClone(selection);
	const weakExactWindow = weakExactRatio.natural_samples.find((sample) =>
		sample.source_id.startsWith('earnings21-'),
	).window;
	weakExactWindow.expected_alignment_exact_pairs = Math.floor(
		weakExactWindow.expected_alignment_paired_tokens * 0.89,
	);
	assert.match(
		validatePublicSelection(weakExactRatio, catalog).join('\n'),
		/alignment.*exact|exact.*ratio|alignment quality|alignment proof.*safety gate/i,
	);

	const weakEditRatio = structuredClone(selection);
	const weakEditWindow = weakEditRatio.natural_samples.find((sample) =>
		sample.source_id.startsWith('earnings21-'),
	).window;
	weakEditWindow.expected_alignment_edit_distance = Math.ceil(
		Math.max(
			weakEditWindow.expected_alignment_hypothesis_tokens,
			weakEditWindow.expected_alignment_reference_tokens,
		) * 0.11,
	);
	assert.match(
		validatePublicSelection(weakEditRatio, catalog).join('\n'),
		/alignment.*edit|edit.*ratio|alignment quality|alignment proof.*safety gate/i,
	);
});

test('prepare argument parsing rejects missing values and keeps network opt-in', () => {
	assert.equal(parsePublicPrepareArgs([]).allowNetwork, false);
	assert.equal(parsePublicPrepareArgs(['--download']).allowNetwork, true);
	assert.equal(
		parsePublicFinalizeArgs(['--minimum-free-gib', '14']).minimumFreeBytes,
		14 * 1024 ** 3,
	);
	for (const flag of [
		'--catalog',
		'--selection',
		'--workspace',
		'--ffmpeg',
		'--minimum-free-gib',
	]) {
		assert.throws(() => parsePublicPrepareArgs([flag]), new RegExp(`${flag} requires a value`));
	}
	for (const [parser, flags] of [
		[
			parsePublicAttestArgs,
			[
				'--catalog',
				'--selection',
				'--workspace',
				'--sample',
				'--reviewer',
				'--affirm-reference-protocol',
			],
		],
		[
			parsePublicFinalizeArgs,
			[
				'--catalog',
				'--selection',
				'--workspace',
				'--minimum-free-gib',
				'--affirm-reference-protocol',
			],
		],
		[parsePublicValidateArgs, ['--catalog', '--selection', '--workspace']],
	]) {
		for (const flag of flags) {
			assert.throws(() => parser([flag]), new RegExp(`${flag} requires a value`));
		}
	}
});

test('repository-local public workspaces must be explicitly ignored', () => {
	const repository = temporaryDirectory('muesly-public-workspace-');
	execFileSync('git', ['init', '--quiet', repository]);
	fs.writeFileSync(path.join(repository, '.gitignore'), '/ignored/\n');
	fs.mkdirSync(path.join(repository, 'ignored'));
	fs.mkdirSync(path.join(repository, 'visible'));
	assert.doesNotThrow(() =>
		assertWorkspaceIsUntracked(path.join(repository, 'ignored'), repository),
	);
	assert.doesNotThrow(() =>
		assertWorkspaceIsUntracked(path.join(repository, 'ignored', 'not-created-yet'), repository),
	);
	assert.throws(
		() => assertWorkspaceIsUntracked(path.join(repository, 'visible'), repository),
		/not ignored/,
	);
	assert.throws(() => assertWorkspaceIsUntracked(repository, repository), /repository root/);
	const outside = temporaryDirectory('muesly-public-workspace-alias-');
	const alias = path.join(outside, 'looks-outside');
	fs.symlinkSync(path.join(repository, 'visible'), alias, 'dir');
	assert.doesNotThrow(() => assertWorkspaceIsUntracked(alias, repository));
	assert.throws(
		() => assertWorkspaceIsUntracked(fs.realpathSync(alias), repository),
		/not ignored/,
	);
});

test('stale public preparation locks are recovered without stealing a live lock', () => {
	const workspace = temporaryDirectory('muesly-public-lock-');
	const staleLock = path.join(workspace, '.prepare.lock');
	fs.mkdirSync(staleLock);
	fs.writeFileSync(
		path.join(staleLock, 'owner.json'),
		`${JSON.stringify({
			schema_version: 1,
			pid: 2_147_483_647,
			token: '00000000-0000-4000-8000-000000000001',
			created_at: '2026-07-17T00:00:00.000Z',
		})}\n`,
	);
	const lock = acquirePreparationLock(workspace, 1000);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(lock.lockPath, 'owner.json'))).pid,
		process.pid,
	);
	assert.throws(() => acquirePreparationLock(workspace, 1), /timed out waiting/);
	releasePreparationLock(lock);
	assert(!fs.existsSync(staleLock));
});

test('stale-lock recovery restores a live replacement observed during the reclaim race', () => {
	const workspace = temporaryDirectory('muesly-public-lock-race-');
	const lockPath = path.join(workspace, '.prepare.lock');
	const displacedStalePath = path.join(workspace, '.displaced-stale-lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		`${JSON.stringify({
			schema_version: 1,
			pid: 2_147_483_647,
			token: '00000000-0000-4000-8000-000000000002',
			created_at: '2026-07-17T00:00:00.000Z',
		})}\n`,
	);
	const liveToken = '00000000-0000-4000-8000-000000000003';
	let replaced = false;
	assert.throws(
		() =>
			acquirePreparationLock(workspace, 20, {
				beforeStaleClaim({ lockPath: observedPath }) {
					if (replaced) return;
					replaced = true;
					fs.renameSync(observedPath, displacedStalePath);
					fs.mkdirSync(observedPath);
					fs.writeFileSync(
						path.join(observedPath, 'owner.json'),
						`${JSON.stringify({
							schema_version: 1,
							pid: process.pid,
							token: liveToken,
							created_at: new Date().toISOString(),
						})}\n`,
					);
				},
			}),
		/timed out waiting/,
	);
	assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'))).token, liveToken);
	assert(fs.existsSync(displacedStalePath));
});

test('lock release never deletes a replacement installed at the canonical path', () => {
	const workspace = temporaryDirectory('muesly-public-lock-release-race-');
	const lock = acquirePreparationLock(workspace, 1000);
	const displaced = path.join(workspace, '.displaced-owned-lock');
	const replacementToken = '00000000-0000-4000-8000-000000000004';
	const released = releasePreparationLock(lock, {
		beforeReleaseClaim({ lockPath }) {
			fs.renameSync(lockPath, displaced);
			fs.mkdirSync(lockPath);
			fs.writeFileSync(
				path.join(lockPath, 'owner.json'),
				`${JSON.stringify({
					schema_version: 1,
					pid: process.pid,
					token: replacementToken,
					created_at: new Date().toISOString(),
				})}\n`,
				{ mode: 0o600 },
			);
		},
	});
	assert.equal(released, false);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(lock.lockPath, 'owner.json'), 'utf8')).token,
		replacementToken,
	);
	assert(fs.existsSync(displaced));
});

test('claimed-lock cleanup preserves a replacement raced after re-attestation', () => {
	const workspace = temporaryDirectory('muesly-public-lock-cleanup-race-');
	const lock = acquirePreparationLock(workspace, 1000);
	let displaced;
	assert.throws(
		() =>
			releasePreparationLock(lock, {
				beforeReleaseCleanup({ claimedPath }) {
					displaced = `${claimedPath}.displaced`;
					fs.renameSync(claimedPath, displaced);
					fs.mkdirSync(claimedPath);
					fs.writeFileSync(
						path.join(claimedPath, 'owner.json'),
						`${JSON.stringify({
							schema_version: 1,
							pid: process.pid,
							token: '00000000-0000-4000-8000-000000000005',
							created_at: new Date().toISOString(),
						})}\n`,
						{ mode: 0o600 },
					);
				},
			}),
		/claimed lock changed before cleanup/,
	);
	assert(fs.existsSync(displaced));
	assert(fs.existsSync(displaced.replace(/\.displaced$/, '')));
});

test('resumable downloads require a matching Content-Range and verify the final hash', async () => {
	const bytes = Buffer.from('a deterministic local HTTP fixture for resume testing');
	let observedRange;
	const fetchImpl = async (_url, request) => {
		observedRange = request.headers.Range;
		const start = Number(/^bytes=(\d+)-$/.exec(observedRange ?? '')?.[1] ?? 0);
		return new Response(bytes.subarray(start), {
			status: start > 0 ? 206 : 200,
			headers:
				start > 0 ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {},
		});
	};
	const cache = temporaryDirectory('muesly-public-download-');
	const destination = path.join(cache, 'fixture.bin');
	fs.writeFileSync(`${destination}.part`, bytes.subarray(0, 11));
	const artifact = {
		id: 'fixture',
		cache_path: 'fixture.bin',
		url: 'https://fixture.invalid/fixture.bin',
		size_bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
	const result = await downloadPinnedArtifact(artifact, cache, { fetchImpl });
	assert.equal(observedRange, 'bytes=11-');
	assert.equal(result.resumed, true);
	assert.deepEqual(fs.readFileSync(destination), bytes);
	assert(!fs.existsSync(`${destination}.part`));
});

test('pinned artifact reads stay descriptor-bound across a pathname replacement race', (t) => {
	if (process.platform === 'win32') {
		t.skip('open-file replacement semantics differ on Windows');
		return;
	}
	const directory = temporaryDirectory('muesly-public-pinned-read-race-');
	const artifactPath = path.join(directory, 'index.tsv');
	const displaced = path.join(directory, 'index.displaced.tsv');
	const bytes = Buffer.from('pinned descriptor contents\n');
	fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
	const artifact = {
		id: 'pinned-read-fixture',
		size_bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
	assert.deepEqual(readPinnedArtifactFile(artifactPath, artifact), bytes);
	assert.throws(
		() =>
			readPinnedArtifactFile(artifactPath, artifact, {
				beforeRead() {
					fs.renameSync(artifactPath, displaced);
					fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
				},
			}),
		/changed while open/,
	);
});

test('pathname-only pinned artifact consumers fail closed on pre-use and in-use replacement', (t) => {
	if (process.platform === 'win32') {
		t.skip('open-file replacement semantics differ on Windows');
		return;
	}
	const bytes = Buffer.from('pinned pathname consumer\n');
	const artifact = {
		id: 'pinned-path-fixture',
		size_bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
	for (const racePoint of ['before-use', 'during-use']) {
		const directory = temporaryDirectory(`muesly-public-pinned-path-${racePoint}-`);
		const artifactPath = path.join(directory, 'source.bin');
		const displaced = path.join(directory, 'source.displaced.bin');
		fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
		let consumerCalled = false;
		const replace = () => {
			fs.renameSync(artifactPath, displaced);
			fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
		};
		assert.throws(
			() =>
				withPinnedArtifactPath(
					artifactPath,
					artifact,
					() => {
						consumerCalled = true;
						if (racePoint === 'during-use') replace();
					},
					racePoint === 'before-use' ? { beforeUse: replace } : {},
				),
			/changed while open/,
		);
		assert.equal(consumerCalled, racePoint === 'during-use');
	}
});

test('pinned downloads reject oversized bodies before writing beyond the byte ceiling', async () => {
	const bytes = Buffer.from('bounded pinned response');
	const cache = temporaryDirectory('muesly-public-download-bound-');
	const destination = path.join(cache, 'fixture.bin');
	const artifact = {
		id: 'bounded-fixture',
		cache_path: 'fixture.bin',
		url: 'https://fixture.invalid/fixture.bin',
		size_bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
	await assert.rejects(
		() =>
			downloadPinnedArtifact(artifact, cache, {
				fetchImpl: async () => new Response(Buffer.concat([bytes, Buffer.from('overflow')])),
			}),
		/response exceeded the pinned size/,
	);
	assert(!fs.existsSync(destination));
	assert(fs.lstatSync(`${destination}.part`).size <= artifact.size_bytes);
});

test('pinned downloads keep writing to one descriptor and detect part-path replacement', async () => {
	const bytes = Buffer.from('descriptor-bound pinned response');
	const cache = temporaryDirectory('muesly-public-download-replacement-');
	const destination = path.join(cache, 'fixture.bin');
	const partial = `${destination}.part`;
	const displaced = `${partial}.displaced`;
	const prefixLength = 7;
	fs.writeFileSync(partial, bytes.subarray(0, prefixLength));
	const artifact = {
		id: 'replacement-fixture',
		cache_path: 'fixture.bin',
		url: 'https://fixture.invalid/fixture.bin',
		size_bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
	await assert.rejects(
		() =>
			downloadPinnedArtifact(artifact, cache, {
				fetchImpl: async () => {
					fs.renameSync(partial, displaced);
					fs.writeFileSync(partial, 'attacker replacement');
					return new Response(bytes.subarray(prefixLength), {
						status: 206,
						headers: {
							'Content-Range': `bytes ${prefixLength}-${bytes.length - 1}/${bytes.length}`,
						},
					});
				},
			}),
		/changed while open/,
	);
	assert.deepEqual(fs.readFileSync(displaced), bytes.subarray(0, prefixLength));
	assert.equal(fs.readFileSync(partial, 'utf8'), 'attacker replacement');
	assert(!fs.existsSync(destination));
});

test('pinned downloads refuse a symbolic-link partial without touching its target', async (t) => {
	if (process.platform === 'win32') {
		t.skip('creating a test symlink may require Windows developer mode');
		return;
	}
	const cache = temporaryDirectory('muesly-public-download-symlink-');
	const destination = path.join(cache, 'fixture.bin');
	const partial = `${destination}.part`;
	const outside = path.join(cache, 'outside.bin');
	fs.writeFileSync(outside, 'outside remains unchanged');
	fs.symlinkSync(outside, partial);
	const bytes = Buffer.from('pinned');
	const artifact = {
		id: 'symlink-fixture',
		cache_path: 'fixture.bin',
		url: 'https://fixture.invalid/fixture.bin',
		size_bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
	await assert.rejects(() =>
		downloadPinnedArtifact(artifact, cache, { fetchImpl: async () => new Response(bytes) }),
	);
	assert.equal(fs.readFileSync(outside, 'utf8'), 'outside remains unchanged');
	assert(!fs.existsSync(destination));
});

test('pinned downloads recover the managed two-link crash state without fetching', async () => {
	const bytes = Buffer.from('verified interrupted publication');
	const cache = temporaryDirectory('muesly-public-download-publish-recovery-');
	const destination = path.join(cache, 'fixture.bin');
	const partial = `${destination}.part`;
	fs.writeFileSync(partial, bytes, { mode: 0o600 });
	fs.linkSync(partial, destination);
	const artifact = {
		id: 'publication-recovery-fixture',
		cache_path: 'fixture.bin',
		url: 'https://fixture.invalid/fixture.bin',
		size_bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex'),
	};
	let fetched = false;
	const result = await downloadPinnedArtifact(artifact, cache, {
		fetchImpl: async () => {
			fetched = true;
			throw new Error('must not fetch a fully published pinned artifact');
		},
	});
	assert.equal(fetched, false);
	assert.equal(result.downloaded, false);
	assert(!fs.existsSync(partial));
	assert.equal(fs.lstatSync(destination).nlink, 1);
	assert.deepEqual(fs.readFileSync(destination), bytes);
});

test('disk preflight preserves its reserve after missing downloads and generated outputs', () => {
	const cache = temporaryDirectory('muesly-public-disk-');
	const catalog = {
		artifacts: [
			{ id: 'one', cache_path: 'one.bin', size_bytes: 100 },
			{ id: 'two', cache_path: 'nested/two.bin', size_bytes: 250 },
		],
	};
	let requirement = calculatePreparationDiskRequirement(catalog, cache, 1000, 500);
	assert.deepEqual(requirement, {
		reserveBytes: 1000,
		missingArtifactBytes: 350,
		generatedOutputBytes: 500,
		requiredBytes: 1850,
	});
	fs.writeFileSync(path.join(cache, 'one.bin'), Buffer.alloc(100));
	fs.mkdirSync(path.join(cache, 'nested'));
	fs.writeFileSync(path.join(cache, 'nested', 'two.bin'), Buffer.alloc(250));
	requirement = calculatePreparationDiskRequirement(catalog, cache, 1000, 500);
	assert.equal(requirement.missingArtifactBytes, 0);
	assert.equal(requirement.requiredBytes, 1500);
});

test('archive validation rejects traversal, aliases, and link entries', () => {
	for (const unsafe of [
		'../escape.wav',
		'/absolute.wav',
		'C:\\escape.wav',
		'a/../../b.wav',
		'--help',
		'a/-option.wav',
	]) {
		assert.match(validateArchiveMemberPaths([unsafe]).join('\n'), /unsafe/);
	}
	assert.match(
		validateArchiveEntries([{ path: 'safe/audio.wav', type: 'symbolic-link' }]).join('\n'),
		/forbidden entry type/,
	);
	assert.match(
		validateArchiveEntries([{ path: 'safe/audio.wav', type: 'hard-link' }]).join('\n'),
		/forbidden entry type/,
	);
	assert.equal(validateArchiveMemberPaths(['test/', 'test/123.wav']).length, 0);
	assert.match(
		validateArchiveMemberPaths(['Audio/clip.wav', 'audio/clip.wav']).join('\n'),
		/case-insensitive filesystem/,
	);
	assert.match(validateArchiveMemberPaths(['audio/cafe\u0301.wav']).join('\n'), /Unicode aliases/);
});

test('private directory creation rejects a symbolic-link ancestor escape', (t) => {
	if (process.platform === 'win32') {
		t.skip('creating a test symlink may require Windows developer mode');
		return;
	}
	const root = temporaryDirectory('muesly-public-ancestor-');
	const outside = temporaryDirectory('muesly-public-ancestor-outside-');
	fs.symlinkSync(outside, path.join(root, 'alias'), 'dir');
	assert.throws(
		() => ensurePrivateDirectory(path.join(root, 'alias', 'nested'), 'fixture directory'),
		/ancestor must be a real directory/,
	);
	assert(!fs.existsSync(path.join(outside, 'nested')));
});

test('tiny local tar fixtures are listed and selectively extracted without network access', () => {
	const directory = temporaryDirectory('muesly-public-archive-');
	const source = path.join(directory, 'source');
	const destination = path.join(directory, 'destination');
	fs.mkdirSync(path.join(source, 'test'), { recursive: true });
	fs.writeFileSync(path.join(source, 'test', '123.wav'), 'fixture-audio');
	const archive = path.join(directory, 'fixture.tar.gz');
	execFileSync('tar', ['-czf', archive, '-C', source, 'test']);
	const entries = listArchiveEntries(archive, 'tar.gz');
	assert(entries.some((entry) => entry.path === 'test/123.wav' && entry.type === 'file'));
	extractArchiveMembers(archive, 'tar.gz', destination, ['test/123.wav'], { entries });
	assert.equal(fs.readFileSync(path.join(destination, 'test', '123.wav'), 'utf8'), 'fixture-audio');
	assert.throws(
		() =>
			extractArchiveMembers(archive, 'tar.gz', path.join(directory, 'bounded'), ['test/123.wav'], {
				entries,
				maximumExtractedBytes: 4,
				maximumMemberBytes: 4,
			}),
		/bounded extraction failed|extraction byte budget/,
	);
});

test('tiny local ZIP fixtures use the AMI listing and selective-extraction path', () => {
	const directory = temporaryDirectory('muesly-public-zip-');
	const source = path.join(directory, 'source');
	const destination = path.join(directory, 'destination');
	fs.mkdirSync(path.join(source, 'words'), { recursive: true });
	fs.writeFileSync(path.join(source, 'words', 'IN1001.A.words.xml'), '<w>fixture</w>');
	fs.writeFileSync(path.join(source, 'words', 'unselected.xml'), '<w>do not extract</w>');
	const archive = path.join(directory, 'fixture.zip');
	execFileSync('zip', ['-q', '-r', archive, 'words'], { cwd: source });
	const entries = listArchiveEntries(archive, 'zip');
	assert(
		entries.some((entry) => entry.path === 'words/IN1001.A.words.xml' && entry.type === 'file'),
	);
	extractArchiveMembers(archive, 'zip', destination, ['words/IN1001.A.words.xml'], {
		entries,
	});
	assert.equal(
		fs.readFileSync(path.join(destination, 'words', 'IN1001.A.words.xml'), 'utf8'),
		'<w>fixture</w>',
	);
	assert(!fs.existsSync(path.join(destination, 'words', 'unselected.xml')));
});

test('existing extraction publication is accepted only when every staged hash matches', () => {
	const directory = temporaryDirectory('muesly-public-extraction-');
	const destination = path.join(directory, 'published');
	const staging = path.join(directory, 'staging');
	for (const root of [destination, staging]) {
		fs.mkdirSync(path.join(root, 'test'), { recursive: true });
		fs.writeFileSync(path.join(root, 'test', '123.wav'), 'same bytes');
	}
	publishExtractedDirectory(staging, destination, ['test/123.wav']);
	assert(!fs.existsSync(staging));

	const tamperedStaging = path.join(directory, 'tampered-staging');
	fs.mkdirSync(path.join(tamperedStaging, 'test'), { recursive: true });
	fs.writeFileSync(path.join(tamperedStaging, 'test', '123.wav'), 'pinned bytes changed');
	assert.throws(
		() => publishExtractedDirectory(tamperedStaging, destination, ['test/123.wav']),
		/differs from the pinned archive member/,
	);
});

test('no-clobber file publication accepts identical output and rejects drift', () => {
	const directory = temporaryDirectory('muesly-public-publish-');
	const destination = path.join(directory, 'final.wav');
	const first = path.join(directory, 'first.wav');
	fs.writeFileSync(first, 'same');
	publishNoClobber(first, destination);
	const identical = path.join(directory, 'identical.wav');
	fs.writeFileSync(identical, 'same');
	assert.equal(publishNoClobber(identical, destination).published, false);
	const drifted = path.join(directory, 'drifted.wav');
	fs.writeFileSync(drifted, 'different');
	assert.throws(() => publishNoClobber(drifted, destination), /refusing to replace/);
});

test('generated reference seeding is recoverable without replacing reviewer text', () => {
	const directory = temporaryDirectory('muesly-public-reference-seed-');
	const empty = path.join(directory, 'empty.txt');
	fs.writeFileSync(empty, '', { mode: 0o600 });
	assert.equal(writeDraftReference(empty, 'Public human reference.\n', { seedEmpty: true }), true);
	assert.equal(fs.readFileSync(empty, 'utf8'), 'Public human reference.\n');

	const reviewed = path.join(directory, 'reviewed.txt');
	fs.writeFileSync(reviewed, 'Reviewer correction.\n', { mode: 0o600 });
	assert.equal(writeDraftReference(reviewed, 'Generated seed.\n', { seedEmpty: true }), false);
	assert.equal(fs.readFileSync(reviewed, 'utf8'), 'Reviewer correction.\n');

	const shortenedReview = path.join(directory, 'shortened-review.txt');
	fs.writeFileSync(shortenedReview, 'Public human', { mode: 0o600 });
	assert.equal(
		writeDraftReference(shortenedReview, 'Public human reference.\n', { seedEmpty: true }),
		false,
	);
	assert.equal(fs.readFileSync(shortenedReview, 'utf8'), 'Public human');

	const recoveredPublication = path.join(directory, 'recovered-publication.txt');
	const publicationTransaction = path.join(directory, '.recovered-publication.txt.publish');
	fs.writeFileSync(publicationTransaction, 'Published seed.\n', { mode: 0o600 });
	fs.linkSync(publicationTransaction, recoveredPublication);
	assert.equal(
		writeDraftReference(recoveredPublication, 'Published seed.\n', { seedEmpty: true }),
		true,
	);
	assert.equal(fs.readFileSync(recoveredPublication, 'utf8'), 'Published seed.\n');
	assert.equal(fs.lstatSync(recoveredPublication, { bigint: true }).nlink, 1n);
	assert(!fs.existsSync(publicationTransaction));
	const ambiguousPublication = path.join(directory, 'ambiguous-publication.txt');
	const ambiguousPublicationTransaction = path.join(
		directory,
		'.ambiguous-publication.txt.publish',
	);
	fs.writeFileSync(ambiguousPublicationTransaction, 'Published', { mode: 0o600 });
	fs.linkSync(ambiguousPublicationTransaction, ambiguousPublication);
	assert.throws(
		() => writeDraftReference(ambiguousPublication, 'Published seed.\n', { seedEmpty: true }),
		/does not match its exact seed/,
	);
	assert.equal(fs.readFileSync(ambiguousPublication, 'utf8'), 'Published');
	assert(fs.existsSync(ambiguousPublicationTransaction));

	const ambiguousEmptySeed = path.join(directory, 'ambiguous-empty-seed.txt');
	const recoveredDraft = 'Recovered public human reference.\n';
	const emptySeedTransaction = path.join(
		directory,
		`.ambiguous-empty-seed.txt.seed-empty-${sha256Text(recoveredDraft)}.txn`,
	);
	fs.writeFileSync(ambiguousEmptySeed, '', { mode: 0o600 });
	fs.linkSync(ambiguousEmptySeed, emptySeedTransaction);
	fs.writeFileSync(ambiguousEmptySeed, 'Recovered public');
	assert.throws(
		() => writeDraftReference(ambiguousEmptySeed, recoveredDraft, { seedEmpty: true }),
		/ambiguous nonempty text; preserving it/,
	);
	assert.equal(fs.readFileSync(ambiguousEmptySeed, 'utf8'), 'Recovered public');
	assert(fs.existsSync(emptySeedTransaction));

	const recoveredEmptySeed = path.join(directory, 'recovered-empty-seed.txt');
	const completedSeedTransaction = path.join(
		directory,
		`.recovered-empty-seed.txt.seed-empty-${sha256Text(recoveredDraft)}.txn`,
	);
	fs.writeFileSync(recoveredEmptySeed, '', { mode: 0o600 });
	fs.linkSync(recoveredEmptySeed, completedSeedTransaction);
	fs.writeFileSync(recoveredEmptySeed, recoveredDraft);
	assert.equal(writeDraftReference(recoveredEmptySeed, recoveredDraft, { seedEmpty: true }), true);
	assert.equal(fs.readFileSync(recoveredEmptySeed, 'utf8'), recoveredDraft);
	assert.equal(fs.lstatSync(recoveredEmptySeed, { bigint: true }).nlink, 1n);
	assert(!fs.existsSync(completedSeedTransaction));

	const target = path.join(directory, 'target.txt');
	const symbolic = path.join(directory, 'symbolic.txt');
	fs.writeFileSync(target, '', { mode: 0o600 });
	fs.symlinkSync(target, symbolic);
	assert.throws(
		() => writeDraftReference(symbolic, 'Seed.\n', { seedEmpty: true }),
		/must be a regular file/,
	);

	const raced = path.join(directory, 'raced.txt');
	const displaced = path.join(directory, 'raced-displaced.txt');
	fs.writeFileSync(raced, '', { mode: 0o600 });
	assert.throws(
		() =>
			writeDraftReference(raced, 'Seed.\n', {
				seedEmpty: true,
				beforeExistingOpen() {
					fs.renameSync(raced, displaced);
					fs.writeFileSync(raced, '', { mode: 0o600 });
				},
			}),
		/changed while opening/,
	);
	assert.equal(fs.readFileSync(raced, 'utf8'), '');
	assert.equal(fs.readFileSync(displaced, 'utf8'), '');
});

test('pinned references publish exact bytes and never overwrite local drift', () => {
	const directory = temporaryDirectory('muesly-public-reference-pinned-');
	const exactReference = 'Exact source-derived public reference.\n';
	const exactSha256 = sha256Text(exactReference);
	const missing = path.join(directory, 'missing.txt');
	assert.equal(writePinnedReference(missing, exactReference, exactSha256), true);
	assert.equal(fs.readFileSync(missing, 'utf8'), exactReference);
	assert.equal(writePinnedReference(missing, exactReference, exactSha256), false);

	const badCommitment = path.join(directory, 'bad-commitment.txt');
	assert.throws(
		() => writePinnedReference(badCommitment, exactReference, sha256Text('different bytes\n')),
		/does not match its committed SHA-256/,
	);
	assert(!fs.existsSync(badCommitment));

	const drifted = path.join(directory, 'drifted.txt');
	fs.writeFileSync(drifted, 'Locally edited reference.\n', { mode: 0o600 });
	assert.throws(
		() => writePinnedReference(drifted, exactReference, exactSha256),
		/differs from the committed source-derived bytes/,
	);
	assert.equal(fs.readFileSync(drifted, 'utf8'), 'Locally edited reference.\n');

	const raced = path.join(directory, 'raced.txt');
	const displaced = path.join(directory, 'raced-displaced.txt');
	fs.writeFileSync(raced, exactReference, { mode: 0o600 });
	assert.throws(
		() =>
			writePinnedReference(raced, exactReference, exactSha256, {
				beforeExistingOpen() {
					fs.renameSync(raced, displaced);
					fs.writeFileSync(raced, exactReference, { mode: 0o600 });
				},
			}),
		/changed while opening/,
	);
	assert.equal(fs.readFileSync(raced, 'utf8'), exactReference);
	assert.equal(fs.readFileSync(displaced, 'utf8'), exactReference);
});

test('FLEURS selection includes deterministic 400 ms gaps in every duration bound', () => {
	const lines = Array.from({ length: 8 }, (_, index) =>
		[
			String(index),
			`${1000 + index}.wav`,
			`Transcript ${index}.`,
			`transcript ${index}`,
			'',
			String(800_000),
			index % 2 ? 'FEMALE' : 'MALE',
		].join('\t'),
	).join('\n');
	const rows = parseFleursTsv(lines);
	const [composite] = selectFleursComposites(rows, {
		count: 1,
		minimumSeconds: 120,
		targetSeconds: 150,
		maximumSeconds: 180,
		gapSeconds: 0.4,
	});
	assert.equal(composite.items.length, 3);
	assert.equal(composite.durationSeconds, 150.8);
	assert.equal(new Set(composite.items.map((item) => item.filename)).size, 3);
	const overlap = planOverlapTimings(composite.items);
	assert.equal(overlap[1].onsetSeconds, 37.5);
});

test('AMI word parsing is Latin-1 aware and excludes boundary-crossing words', () => {
	const xml = Buffer.from(
		'<?xml version="1.0" encoding="ISO-8859-1"?>' +
			'<nite:root>' +
			'<w starttime="29.5" endtime="30.5">clipped</w>' +
			'<w starttime="31" endtime="31.4">caf&#233;</w>' +
			'<w starttime="31.4" endtime="31.4" punc="true">.</w>' +
			'<w starttime="61" endtime="61.2">outside</w>' +
			'</nite:root>',
		'latin1',
	);
	const words = parseAmiWordDocuments([{ speakerId: 'A', content: xml }]);
	assert.equal(renderTimedReference(words, 30, 60), 'café.\n');
	const window = selectDensestTimedWindow(words, 30, 30);
	assert(window.words.every((word) => word.start >= window.start && word.end <= window.end));
});

test('AMI dense-window scoring counts lexical words only while retaining selected punctuation', () => {
	const lexical = (text, start, end) => ({ text, start, end, punctuation: false });
	const punctuation = (text, start) => ({ text, start, end: start, punctuation: true });
	const words = [
		lexical('early', 1, 1.1),
		lexical('window', 2, 2.1),
		punctuation('.', 3),
		punctuation(',', 4),
		punctuation('?', 5),
		punctuation('!', 6),
		lexical('later', 11, 11.5),
		lexical('lexical', 12, 12.5),
		punctuation('.', 12.5),
		lexical('window', 19, 20),
	];
	const window = selectDensestTimedWindow(words, 10, 10);
	assert.equal(window.start, 10);
	assert.equal(window.wordCount, 3);
	assert.equal(window.words.length, 4);
	assert.equal(renderTimedReference(window.words, window.start, window.end), 'later lexical. window\n');
});

test('Earnings-21 timing tolerances admit the pinned edge cases and reject severe zig-zags', () => {
	assert.equal(EARNINGS_MAX_START_REGRESSION_SECONDS, 0.04);
	assert.equal(EARNINGS_MAX_ADJACENT_OVERLAP_SECONDS, 0.35);
	const hypothesis = (rows) =>
		[
			'token|speaker|ts|endTs|punctuation|case|tags',
			...rows.map(
				([token, start, end]) => `${token}|1|${String(start)}|${String(end)}|||`,
			),
		].join('\n');
	assert.equal(
		parseEarningsTimedHypothesis(
			hypothesis([
				['alpha', 1, 1.1],
				['bravo', 0.96, 1.2],
				['charlie', 1.2, 2],
				['delta', 1.65, 2.1],
			]),
		).length,
		4,
	);
	assert.throws(
		() =>
			parseEarningsTimedHypothesis(
				hypothesis([
					['alpha', 1, 1.1],
					['bravo', 0.959, 1.2],
				]),
			),
		/regresses more than 0\.04 seconds/,
	);
	assert.throws(
		() =>
			parseEarningsTimedHypothesis(
				hypothesis([
					['alpha', 1, 1.1],
					['bravo', 0.97, 1.2],
					['charlie', 0.94, 1.3],
				]),
			),
		/regresses more than 0\.04 seconds/,
	);
	assert.throws(
		() =>
			parseEarningsTimedHypothesis(
				hypothesis([
					['alpha', 1, 2],
					['bravo', 1.9, 1.99],
				]),
			),
		/decreasing end timestamp/,
	);
	assert.throws(
		() =>
			parseEarningsTimedHypothesis(
				hypothesis([
					['alpha', 1, 2],
					['bravo', 1.649, 2.1],
				]),
			),
		/overlaps its predecessor by more than 0\.35 seconds/,
	);
});

test('Earnings-21 alignment slices the public human reference on exact timed anchors', () => {
	const referenceTokens = [
		'Before',
		'alpha',
		'preserved',
		'bravo',
		'charlie',
		'delta',
		'echo',
		'foxtrot',
		'golf',
		'hotel',
		'india',
		'juliet',
		'after',
	];
	const hypothesisTokens = referenceTokens.filter((token) => token !== 'preserved');
	const reference = [
		'token|speaker|ts|endTs|punctuation|case|tags|wer_tags',
		...referenceTokens.map(
			(token, index) =>
				`${token}|1|||${token === 'juliet' ? '.' : ''}|${index === 0 ? 'UC' : 'LC'}|[]|[]`,
		),
	].join('\n');
	const hypothesisTimes = [
		[8, 8.2],
		[10.2, 10.5],
		[11, 11.3],
		[12, 12.3],
		[13, 13.3],
		[14, 14.3],
		[15, 15.3],
		[16, 16.3],
		[17, 17.3],
		[18, 18.3],
		[19, 19.5],
		[20.1, 20.4],
	];
	const hypothesis = [
		'token|speaker|ts|endTs|punctuation|case|tags',
		...hypothesisTokens.map(
			(token, index) =>
				`${token.toLowerCase()}|1|${hypothesisTimes[index][0]}|${hypothesisTimes[index][1]}|||`,
		),
	].join('\n');
	const aligned = deriveEarningsReferenceExcerpt(reference, hypothesis, {
		startSeconds: 10,
		endSeconds: 20,
		contextSeconds: 5,
	});
	assert.equal(
		aligned.text,
		'alpha preserved bravo charlie delta echo foxtrot golf hotel india juliet.\n',
	);
	assert.equal(aligned.referenceStartTokenIndex, 1);
	assert.equal(aligned.referenceEndTokenIndex, 11);
	assert.equal(aligned.referenceTokenCount, 11);
	assert.equal(aligned.editDistance, 1);
	assert.equal(aligned.exactPairs, 12);
	assert.equal(aligned.startAnchor.context.tokenCount, 2);
	assert.equal(aligned.endAnchor.context.tokenCount, 2);
	assert(aligned.startEdgeSeconds <= 2.5);
	assert(aligned.endEdgeSeconds <= 2.5);

	const shortReference = [
		'token|speaker|ts|endTs|punctuation|case|tags|wer_tags',
		'one|1||||LC|[]|[]',
		'two|1||||LC|[]|[]',
		'three|1||||LC|[]|[]',
	].join('\n');
	const longHypothesis = [
		'token|speaker|ts|endTs|punctuation|case|tags',
		...Array.from({ length: 10 }, (_, index) => `word${index}|1|${index}|${index + 0.5}|||`),
	].join('\n');
	assert.throws(
		() =>
			deriveEarningsReferenceExcerpt(shortReference, longHypothesis, {
				startSeconds: 1,
				endSeconds: 5,
				contextSeconds: 5,
			}),
		/alignment quality is unsafe/,
	);

	const ambiguousReference = [
		'token|speaker|ts|endTs|punctuation|case|tags|wer_tags',
		...Array.from({ length: 12 }, () => 'repeat|1||||LC|[]|[]'),
	].join('\n');
	const ambiguousHypothesis = [
		'token|speaker|ts|endTs|punctuation|case|tags',
		...Array.from({ length: 12 }, (_, index) => `repeat|1|${index}|${index + 0.4}|||`),
	].join('\n');
	assert.throws(
		() =>
			deriveEarningsReferenceExcerpt(ambiguousReference, ambiguousHypothesis, {
				startSeconds: 2,
				endSeconds: 9,
				contextSeconds: 2,
			}),
		/unique exact multi-token boundary anchors/,
	);

	const edgeReferenceTokens = Array.from({ length: 12 }, (_, index) => `unique${index}`);
	const edgeReference = [
		'token|speaker|ts|endTs|punctuation|case|tags|wer_tags',
		...edgeReferenceTokens.map((token) => `${token}|1||||LC|[]|[]`),
	].join('\n');
	const edgeHypothesis = [
		'token|speaker|ts|endTs|punctuation|case|tags',
		...edgeReferenceTokens.map(
			(token, index) => `${token}|1|${13 + index * 0.35}|${13.2 + index * 0.35}|||`,
		),
	].join('\n');
	assert.throws(
		() =>
			deriveEarningsReferenceExcerpt(edgeReference, edgeHypothesis, {
				startSeconds: 10,
				endSeconds: 20,
				contextSeconds: 5,
			}),
		/boundary anchors are too far from the excerpt edges/,
	);
	assert.throws(
		() =>
			deriveEarningsReferenceExcerpt(
				reference,
				['token|speaker|ts|endTs|punctuation|case|tags', 'alpha|1|||||'].join('\n'),
				{ startSeconds: 10, endSeconds: 20, contextSeconds: 5 },
			),
		/alignment hypothesis line 2 is invalid/,
	);
});

test('office-noise gain calculation targets measured 10 dB RMS separation', () => {
	assert.equal(noiseGainForSnr(-20, -25, 10), -5);
	assert.equal(-20 - (-25 - 5), 10);
	assert.throws(() => noiseGainForSnr(-20, -25, 0), /positive target/);
});

function writeFixtureWav(filePath, marker, durationSeconds = 1) {
	const sampleRate = 16_000;
	const dataBytes = sampleRate * 2 * durationSeconds;
	const wav = Buffer.alloc(44 + dataBytes);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + dataBytes, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(dataBytes, 40);
	wav.writeInt16LE((marker % 32_766) + 1, 44);
	fs.writeFileSync(filePath, wav);
}

function writePreparedFixture(workspace) {
	const catalogDocument = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
	const catalogSourceById = new Map(catalogDocument.sources.map((source) => [source.id, source]));
	const catalogArtifactById = new Map(
		catalogDocument.artifacts.map((artifact) => [artifact.id, artifact]),
	);
	const baseSelection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
	const fixtureFfmpegPath = path.join(workspace, 'ffmpeg-fixture');
	fs.writeFileSync(fixtureFfmpegPath, '#!/bin/sh\necho "ffmpeg version fixture"\n', {
		mode: 0o700,
	});
	const fixtureFfmpeg = {
		id: 'ffmpeg-fixture',
		sha256: fileSha256(fixtureFfmpegPath),
		version: 'ffmpeg version fixture',
	};
	baseSelection.approved_ffmpeg = [fixtureFfmpeg];
	baseSelection.fleurs.minimum_seconds = 1;
	baseSelection.fleurs.target_seconds = 1;
	baseSelection.fleurs.maximum_seconds = 180;
	baseSelection.fleurs.inter_utterance_gap_seconds = 0;
	let committedMember = 100_000;
	let compositeOrdinal = 0;
	for (const source of baseSelection.fleurs.sources) {
		for (const composite of source.composites) {
			compositeOrdinal += 1;
			committedMember += 1;
			const filename = `${committedMember}.wav`;
			composite.member_count = 1;
			composite.ordered_members_sha256 = sha256Text(JSON.stringify([filename]));
			composite.clean_duration_seconds = compositeOrdinal === 1 ? 150 : 1;
			composite.overlap_duration_seconds = composite.clean_duration_seconds;
			const baseId = `${source.whisper_language}-fleurs-${String(composite.index).padStart(2, '0')}`;
			composite.fixture_reference_text = `Pinned fixture reference for ${baseId}.\n`;
			composite.reference_sha256 = sha256Text(composite.fixture_reference_text);
			composite.audio_sha256 = Object.fromEntries(
				baseSelection.fleurs.conditions.map((condition) => [
					condition.id,
					sha256Text(`fixture-${source.source_id}-${composite.index}-${condition.id}`),
				]),
			);
			composite.fixture_filename = filename;
		}
	}
	for (const [index, sample] of baseSelection.natural_samples.entries()) {
		sample.duration_seconds = sample.window.strategy === 'fixed' || index === 0 ? 180 : 1;
		sample.audio_sha256 = sha256Text(`fixture-${sample.id}`);
		sample.fixture_reference_text = `Pinned fixture reference for ${sample.id}.\n`;
		sample.reference_sha256 = sha256Text(sample.fixture_reference_text);
		if (sample.window.strategy === 'densest-timed-words') {
			sample.window.expected_end_seconds =
				sample.window.expected_start_seconds + sample.duration_seconds;
		} else {
			sample.window.expected_reference_seed_sha256 = sample.reference_sha256;
		}
	}
	const fixtureSelectionPath = path.join(workspace, 'selection-fixture.json');
	const selectionForDisk = structuredClone(baseSelection);
	for (const source of selectionForDisk.fleurs.sources) {
		for (const composite of source.composites) {
			delete composite.fixture_filename;
			delete composite.fixture_reference_text;
		}
	}
	for (const sample of selectionForDisk.natural_samples) delete sample.fixture_reference_text;
	atomicWriteJson(fixtureSelectionPath, selectionForDisk);
	const { catalog, selection } = loadPublicCorpusConfig(catalogPath, fixtureSelectionPath);
	fs.mkdirSync(path.join(workspace, 'audio'));
	fs.mkdirSync(path.join(workspace, 'references'));
	const samples = [];
	let marker = 0;
	const addSample = (definition) => {
		marker += 1;
		const { id } = definition;
		const audioPath = path.join(workspace, 'audio', `${id}.wav`);
		const referencePath = path.join(workspace, definition.reference_path);
		writeFixtureWav(audioPath, marker, definition.duration_seconds);
		if (!fs.existsSync(referencePath)) {
			fs.writeFileSync(referencePath, definition.reference_text, { mode: 0o600 });
		}
		assert.equal(fileSha256(referencePath), definition.reference_sha256);
		samples.push({
			id,
			...(definition.session_id ? { session_id: definition.session_id } : {}),
			audio_path: `audio/${id}.wav`,
			audio_sha256: fileSha256(audioPath),
			reference_path: definition.reference_path,
			reference_sha256: definition.reference_sha256,
			reference_verification: definition.reference_verification,
			language: definition.language,
			whisper_language: definition.whisper_language,
			scenario: definition.scenario,
			noise_condition: definition.noise_condition,
			speakers: definition.speakers,
			duration_seconds: definition.duration_seconds,
			dataset: definition.dataset,
			source_window: definition.source_window,
			provenance: {
				basis: 'public-license',
				redistribution: 'local-only',
				source_catalog_id: catalog.catalog_id,
				source_item_ids: definition.source_item_ids,
				transform_id: definition.transform_id,
			},
		});
	};
	for (const source of selection.fleurs.sources) {
		const catalogSource = catalogSourceById.get(source.source_id);
		for (let index = 1; index <= selection.fleurs.composites_per_language; index += 1) {
			const baseId = `${source.whisper_language}-fleurs-${String(index).padStart(2, '0')}`;
			const composite = source.composites[index - 1];
			const fixtureComposite = baseSelection.fleurs.sources.find(
				(candidate) => candidate.source_id === source.source_id,
			).composites[index - 1];
			const filename = fixtureComposite.fixture_filename;
			for (const condition of selection.fleurs.conditions) {
				const durationSeconds =
					condition.id === 'synthetic-overlap'
						? composite.overlap_duration_seconds
						: composite.clean_duration_seconds;
				addSample({
					id: `${baseId}-${condition.id}`,
					session_id: `session-${baseId}`,
					reference_path: `references/${baseId}.txt`,
					reference_text: fixtureComposite.fixture_reference_text,
					reference_sha256: composite.reference_sha256,
					reference_verification: catalogSource.reference_verification,
					language: source.language,
					whisper_language: source.whisper_language,
					scenario: 'read-speech',
					noise_condition: condition.id,
					speakers: condition.speakers,
					duration_seconds: durationSeconds,
					dataset: 'fleurs',
					source_window: {
						strategy: 'committed-fleurs-composite',
						composite_index: index,
						gap_seconds: 0,
						member_count: 1,
						ordered_members_sha256: composite.ordered_members_sha256,
						expected_duration_seconds: durationSeconds,
						reference_order_policy: 'source-item-onset',
						monotonic_onsets: true,
					},
					source_item_ids: [`${source.source_id}:${filename}`],
					transform_id: condition.transform_id,
				});
			}
		}
	}
	for (const sample of selection.natural_samples) {
		const catalogSource = catalogSourceById.get(sample.source_id);
		const dataset =
			catalogSource.reference_verification === PUBLIC_REFERENCE_RECIPES.AMI ? 'ami' : 'earnings21';
		const referenceArtifactId = catalogSource.artifact_ids.find(
			(artifactId) => catalogArtifactById.get(artifactId).kind === 'reference',
		);
		const alignmentArtifactId = catalogSource.artifact_ids.find(
			(artifactId) => catalogArtifactById.get(artifactId).kind === 'alignment-hypothesis',
		);
		const annotationArtifactId = catalogSource.artifact_ids.find(
			(artifactId) => catalogArtifactById.get(artifactId).kind === 'reference-archive',
		);
		const referenceArtifact = catalogArtifactById.get(referenceArtifactId);
		const alignmentArtifact = catalogArtifactById.get(alignmentArtifactId);
		const annotationArtifact = catalogArtifactById.get(annotationArtifactId);
		const sourceWindow =
			sample.window.strategy === 'densest-timed-words'
				? {
						strategy: sample.window.strategy,
						start_seconds: sample.window.expected_start_seconds,
						end_seconds: sample.window.expected_end_seconds,
						boundary_policy: 'exclude-crossing-words',
						word_count: sample.window.expected_word_count,
						start_crossing_word_count: sample.window.expected_start_crossing_word_count,
						end_crossing_word_count: sample.window.expected_end_crossing_word_count,
						annotation_artifact_id: annotationArtifactId,
						annotation_source_revision: catalogSource.revision,
						annotation_artifact_sha256: annotationArtifact.sha256,
						annotation_member_count: sample.window.annotation_member_count,
						ordered_annotation_members_sha256: sample.window.ordered_annotation_members_sha256,
					}
				: {
						strategy: 'fixed',
						start_seconds: sample.window.start_seconds,
						end_seconds: sample.window.start_seconds + sample.duration_seconds,
						boundary_policy: 'exclude-crossing-anchor-words',
						reference_policy: 'public-human-reference-aligned-to-pinned-timed-hypothesis',
						reference_artifact_id: referenceArtifactId,
						reference_artifact_revision: referenceArtifact.revision,
						alignment_artifact_id: alignmentArtifactId,
						alignment_artifact_revision: alignmentArtifact.revision,
						alignment_role: alignmentArtifact.role,
						alignment_context_seconds: sample.window.alignment_context_seconds,
						alignment_hypothesis_tokens: sample.window.expected_alignment_hypothesis_tokens,
						alignment_reference_tokens: sample.window.expected_alignment_reference_tokens,
						alignment_edit_distance: sample.window.expected_alignment_edit_distance,
						alignment_paired_tokens: sample.window.expected_alignment_paired_tokens,
						alignment_exact_pairs: sample.window.expected_alignment_exact_pairs,
						reference_start_token_index: sample.window.expected_reference_start_token_index,
						reference_end_token_index: sample.window.expected_reference_end_token_index,
						reference_token_count: sample.window.expected_reference_token_count,
						anchor_context_tokens: sample.window.expected_anchor_context_tokens,
						start_anchor_hypothesis_token_index:
							sample.window.expected_start_anchor_hypothesis_token_index,
						start_anchor_start_seconds: sample.window.expected_start_anchor_start_seconds,
						start_anchor_end_seconds: sample.window.expected_start_anchor_end_seconds,
						start_anchor_context_sha256: sample.window.expected_start_anchor_context_sha256,
						end_anchor_hypothesis_token_index:
							sample.window.expected_end_anchor_hypothesis_token_index,
						end_anchor_start_seconds: sample.window.expected_end_anchor_start_seconds,
						end_anchor_end_seconds: sample.window.expected_end_anchor_end_seconds,
						end_anchor_context_sha256: sample.window.expected_end_anchor_context_sha256,
						reference_seed_sha256: sample.window.expected_reference_seed_sha256,
					};
		const fixtureSample = baseSelection.natural_samples.find(
			(candidate) => candidate.id === sample.id,
		);
		addSample({
			...sample,
			dataset,
			source_window: sourceWindow,
			reference_path: `references/${sample.id}.txt`,
			reference_text: fixtureSample.fixture_reference_text,
			reference_sha256: sample.reference_sha256,
			reference_verification: catalogSource.reference_verification,
			source_item_ids: [sample.source_item_id],
			...(sample.scenario === 'meeting' ? { session_id: `session-${sample.source_id}` } : {}),
		});
	}
	samples.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	const samplesById = new Map(samples.map((sample) => [sample.id, sample]));
	for (const source of selectionForDisk.fleurs.sources) {
		for (const composite of source.composites) {
			const baseId = `${source.whisper_language}-fleurs-${String(composite.index).padStart(2, '0')}`;
			composite.audio_sha256 = Object.fromEntries(
				selectionForDisk.fleurs.conditions.map((condition) => {
					const sample = samplesById.get(`${baseId}-${condition.id}`);
					return [condition.id, sample.audio_sha256];
				}),
			);
		}
	}
	for (const sample of selectionForDisk.natural_samples) {
		sample.audio_sha256 = samplesById.get(sample.id).audio_sha256;
	}
	atomicWriteJson(fixtureSelectionPath, selectionForDisk);
	const prepared = {
		schema_version: PUBLIC_PREPARED_SCHEMA_VERSION,
		corpus_id: selection.corpus_id,
		source_catalog_id: catalog.catalog_id,
		source_catalog_sha256: fileSha256(catalogPath),
		selection_sha256: fileSha256(fixtureSelectionPath),
		reference_protocol_id: PUBLIC_REFERENCE_PROTOCOL_ID,
		ffmpeg: {
			id: fixtureFfmpeg.id,
			executable_path: fixtureFfmpegPath,
			sha256: fixtureFfmpeg.sha256,
			version: fixtureFfmpeg.version,
		},
		samples,
	};
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);
	Object.defineProperty(prepared, 'fixtureSelectionPath', { value: fixtureSelectionPath });
	return prepared;
}

test('pinned upstream-gold samples reject local review attestations', () => {
	const workspace = temporaryDirectory('muesly-public-attest-');
	const prepared = writePreparedFixture(workspace);
	atomicWriteJson(
		path.join(workspace, 'review-attestations.json'),
		createReviewTemplate(prepared.samples),
	);
	const firstSample = prepared.samples[0];
	const baseOptions = {
		workspace,
		catalogPath,
		selectionPath: prepared.fixtureSelectionPath,
		sampleId: firstSample.id,
		affirmReferenceProtocol: PUBLIC_REFERENCE_PROTOCOL_ID,
		acceptReviewedReference: true,
		reviewerId: 'reviewer-one',
	};
	assert.throws(
		() => recordPublicReviewAttestation(baseOptions),
		/pinned upstream gold; restore its exact source-derived bytes/,
	);
	assert.throws(
		() =>
			recordPublicReviewAttestation({
				...baseOptions,
				affirmReferenceProtocol: REFERENCE_PROTOCOL_ID,
			}),
		new RegExp(`review requires --affirm-reference-protocol ${PUBLIC_REFERENCE_PROTOCOL_ID}`),
	);
	const recorded = JSON.parse(
		fs.readFileSync(path.join(workspace, 'review-attestations.json'), 'utf8'),
	);
	assert.equal(recorded.reference_protocol_id, PUBLIC_REFERENCE_PROTOCOL_ID);
	assert(recorded.samples.every((sample) => sample.reviewers.length === 0));
});

test('untouched legacy empty review templates migrate without accepting legacy evidence', () => {
	assert.equal(PUBLIC_REVIEW_SCHEMA_VERSION, 1);
	const workspace = temporaryDirectory('muesly-public-review-migration-');
	const prepared = writePreparedFixture(workspace);
	const reviewsPath = path.join(workspace, 'review-attestations.json');
	const legacy = {
		schema_version: 1,
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		samples: prepared.samples.map((sample) => ({ sample_id: sample.id, reviewers: [] })),
	};
	atomicWriteJson(reviewsPath, legacy);
	writePreparedBundle(workspace, prepared);
	const migrated = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
	assert.equal(migrated.schema_version, PUBLIC_REVIEW_SCHEMA_VERSION);
	assert.equal(migrated.reference_protocol_id, PUBLIC_REFERENCE_PROTOCOL_ID);
	assert(migrated.samples.every((sample) => sample.reviewers.length === 0));

	legacy.samples[0].reviewers.push({ reviewer_id: 'legacy-evidence-must-not-be-rewritten' });
	atomicWriteJson(reviewsPath, legacy);
	assert.throws(
		() => writePreparedBundle(workspace, prepared),
		/retired protocol.*audit evidence|legacy.*audit evidence/i,
	);
	assert.deepEqual(JSON.parse(fs.readFileSync(reviewsPath, 'utf8')), legacy);
});

test('empty exact-upstream review templates finalize all 66 pinned references', async () => {
	const workspace = temporaryDirectory('muesly-public-finalize-');
	const prepared = writePreparedFixture(workspace);
	const reviews = createReviewTemplate(prepared.samples);
	atomicWriteJson(path.join(workspace, 'review-attestations.json'), reviews);
	const options = {
		workspace,
		catalogPath,
		selectionPath: prepared.fixtureSelectionPath,
		affirmReferenceProtocol: PUBLIC_REFERENCE_PROTOCOL_ID,
	};
	const dependencies = { rebuildPreparedOutputs: async () => {} };
	assert.equal(prepared.schema_version, PUBLIC_PREPARED_SCHEMA_VERSION);
	assert.equal(prepared.reference_protocol_id, PUBLIC_REFERENCE_PROTOCOL_ID);
	assert(
		prepared.samples.every(
			(sample) =>
				/^[a-f0-9]{64}$/.test(sample.reference_sha256) &&
				Object.values(PUBLIC_REFERENCE_RECIPES).includes(sample.reference_verification),
		),
	);
	const firstSample = prepared.samples[0];
	const changedReference = path.join(workspace, firstSample.reference_path);
	const originalReference = fs.readFileSync(changedReference);
	fs.appendFileSync(changedReference, 'locally mutated before finalization\n');
	await assert.rejects(
		finalizePublicCorpus(options, dependencies),
		/reference_sha256 does not match the committed source-derived reference/,
	);
	fs.writeFileSync(changedReference, originalReference);

	const originalReferenceSha256 = firstSample.reference_sha256;
	firstSample.reference_sha256 = 'f'.repeat(64);
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);
	await assert.rejects(
		finalizePublicCorpus(options, dependencies),
		/reference_sha256 does not match the committed source-derived reference/,
	);
	firstSample.reference_sha256 = originalReferenceSha256;
	const originalRecipe = firstSample.reference_verification;
	firstSample.reference_verification = 'untrusted-local-file-v1';
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);
	await assert.rejects(
		finalizePublicCorpus(options, dependencies),
		/reference_verification must be a supported source recipe|does not match the source catalog recipe/,
	);
	firstSample.reference_verification = originalRecipe;
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);

	const replacedSample = prepared.samples[0];
	const replacedAudio = path.join(workspace, replacedSample.audio_path);
	const displacedAudio = `${replacedAudio}.displaced`;
	await assert.rejects(
		finalizePublicCorpus(options, {
			rebuildPreparedOutputs: async () => {},
			beforeManifestPublish() {
				fs.renameSync(replacedAudio, displacedAudio);
				fs.copyFileSync(displacedAudio, replacedAudio);
			},
		}),
		/changed while open/,
	);
	fs.rmSync(replacedAudio);
	fs.renameSync(displacedAudio, replacedAudio);
	const finalized = await finalizePublicCorpus(options, dependencies);
	assert.equal(finalized.sampleCount, 66);
	assert.equal(validateFinalizedPublicCorpus(options).length, 0);

	fs.appendFileSync(changedReference, 'changed after finalization\n');
	assert.match(
		validateFinalizedPublicCorpus(options).join('\n'),
		/reference_sha256 does not match the committed source-derived reference/,
	);
	fs.writeFileSync(changedReference, originalReference);

	const manifestPath = path.join(workspace, 'corpus-local.json');
	const originalManifest = fs.readFileSync(manifestPath);
	const changedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	changedManifest.samples[0].language = 'fr';
	atomicWriteJson(manifestPath, changedManifest);
	assert.match(
		validateFinalizedPublicCorpus(options).join('\n'),
		/manifest does not exactly match/,
	);
	await assert.rejects(
		finalizePublicCorpus(options, dependencies),
		/refusing to replace different existing JSON/,
	);
	fs.writeFileSync(manifestPath, originalManifest);

	const originalDurationSeconds = firstSample.duration_seconds;
	firstSample.duration_seconds = originalDurationSeconds + 1;
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);
	await assert.rejects(finalizePublicCorpus(options, dependencies), /committed selection/);
	firstSample.duration_seconds = originalDurationSeconds;
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);

	const longSample = prepared.samples.find((sample) => sample.duration_seconds === 180);
	assert(longSample, 'fixture must exercise a full 180-second sample');
	const longAudioPath = path.join(workspace, longSample.audio_path);
	const regeneratedBytes = fs.readFileSync(longAudioPath);
	writeFixtureWav(longAudioPath, 31_337, 180);
	longSample.audio_sha256 = fileSha256(longAudioPath);
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);
	await assert.rejects(
		finalizePublicCorpus(options, {
			rebuildPreparedOutputs: async () => {
				const regeneratedPath = path.join(workspace, '.regenerated-180s.wav');
				fs.writeFileSync(regeneratedPath, regeneratedBytes, { flag: 'wx', mode: 0o600 });
				publishNoClobber(regeneratedPath, longAudioPath);
			},
		}),
		/refusing to replace different existing generated output/,
	);
	fs.rmSync(path.join(workspace, '.regenerated-180s.wav'), { force: true });
	await assert.rejects(
		finalizePublicCorpus(options, dependencies),
		/committed deterministic output/,
	);
});
