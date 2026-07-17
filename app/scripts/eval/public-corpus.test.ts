import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fileSha256, REFERENCE_PROTOCOL_ID } from './corpus.ts';
import {
	acquirePreparationLock,
	assertWorkspaceIsUntracked,
	calculatePreparationDiskRequirement,
	noiseGainForSnr,
	parsePublicPrepareArgs,
	publishExtractedDirectory,
	publishNoClobber,
	releasePreparationLock,
} from './public-corpus-prepare.ts';
import { parsePublicAttestArgs } from './public-corpus-attest.ts';
import { parsePublicFinalizeArgs } from './public-corpus-finalize.ts';
import { parsePublicValidateArgs } from './public-corpus-validate.ts';
import {
	atomicWriteJson,
	createReviewTemplate,
	downloadPinnedArtifact,
	ensurePrivateDirectory,
	expectedPublicSampleIds,
	extractArchiveMembers,
	finalizePublicCorpus,
	listArchiveEntries,
	loadPublicCorpusConfig,
	parseAmiWordDocuments,
	parseFleursTsv,
	planOverlapTimings,
	recordPublicReviewAttestation,
	renderTimedReference,
	selectDensestTimedWindow,
	selectFleursComposites,
	sha256Text,
	validateArchiveEntries,
	validateArchiveMemberPaths,
	validateFinalizedPublicCorpus,
	validatePublicSelection,
} from './public-corpus.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(here, 'public-corpus-sources.json');
const selectionPath = path.join(here, 'public-corpus-selection.json');

function temporaryDirectory(prefix = 'muesly-public-corpus-') {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('committed public source pins and deterministic selection are internally complete', () => {
	const { catalog, selection } = loadPublicCorpusConfig(catalogPath, selectionPath);
	assert.equal(catalog.catalog_id, 'muesly-public-asr-sources-v1');
	assert.equal(catalog.artifacts.length, 20);
	assert.equal(catalog.sources.length, 11);
	assert.equal(expectedPublicSampleIds(selection).length, 66);
	assert.equal(new Set(expectedPublicSampleIds(selection)).size, 66);
	assert.equal(selection.fleurs.inter_utterance_gap_seconds, 0.4);
	const missingPins = structuredClone(selection);
	delete missingPins.fleurs.sources[0].composites[0].audio_sha256['clean-read'];
	delete missingPins.natural_samples[0].audio_sha256;
	const missingPinErrors = validatePublicSelection(missingPins, catalog).join('\n');
	assert.match(missingPinErrors, /audio_sha256\.clean-read must be a non-placeholder/);
	assert.match(missingPinErrors, /natural_samples\[0\]\.audio_sha256 must be a non-placeholder/);
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
			.map((sample) => [sample.source_item_id, sample.window]),
		[
			['earnings21:4320211', { strategy: 'fixed', start_seconds: 60 }],
			['earnings21:4330115', { strategy: 'fixed', start_seconds: 60 }],
			['earnings21:4341191', { strategy: 'fixed', start_seconds: 60 }],
		],
	);
});

test('prepare argument parsing rejects missing values and keeps network opt-in', () => {
	assert.equal(parsePublicPrepareArgs([]).allowNetwork, false);
	assert.equal(parsePublicPrepareArgs(['--download']).allowNetwork, true);
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
			['--catalog', '--selection', '--workspace', '--affirm-reference-protocol'],
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
		sample.duration_seconds = index === 0 ? 180 : 1;
		sample.audio_sha256 = sha256Text(`fixture-${sample.id}`);
		if (sample.window.strategy === 'densest-timed-words') {
			sample.window.expected_end_seconds =
				sample.window.expected_start_seconds + sample.duration_seconds;
		}
	}
	const fixtureSelectionPath = path.join(workspace, 'selection-fixture.json');
	const selectionForDisk = structuredClone(baseSelection);
	for (const source of selectionForDisk.fleurs.sources) {
		for (const composite of source.composites) delete composite.fixture_filename;
	}
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
			fs.writeFileSync(referencePath, `Reviewed fixture reference for ${id}.\n`);
		}
		samples.push({
			id,
			audio_path: `audio/${id}.wav`,
			audio_sha256: fileSha256(audioPath),
			reference_path: definition.reference_path,
			language: definition.language,
			whisper_language: definition.whisper_language,
			scenario: definition.scenario,
			noise_condition: definition.noise_condition,
			speakers: definition.speakers,
			duration_seconds: definition.duration_seconds,
			dataset: definition.dataset,
			source_window: definition.source_window,
			...(definition.session_id ? { session_id: definition.session_id } : {}),
			...(definition.requires_manual_reference ? { requires_manual_reference: true } : {}),
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
		for (let index = 1; index <= selection.fleurs.composites_per_language; index += 1) {
			const baseId = `${source.whisper_language}-fleurs-${String(index).padStart(2, '0')}`;
			const composite = source.composites[index - 1];
			const filename = baseSelection.fleurs.sources.find(
				(candidate) => candidate.source_id === source.source_id,
			).composites[index - 1].fixture_filename;
			for (const condition of selection.fleurs.conditions) {
				const durationSeconds =
					condition.id === 'synthetic-overlap'
						? composite.overlap_duration_seconds
						: composite.clean_duration_seconds;
				addSample({
					id: `${baseId}-${condition.id}`,
					reference_path: `references/${baseId}.txt`,
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
					},
					source_item_ids: [`${source.source_id}:${filename}`],
					transform_id: condition.transform_id,
				});
			}
		}
	}
	for (const sample of selection.natural_samples) {
		const dataset = sample.source_id.startsWith('ami-') ? 'ami' : 'earnings21';
		const sourceWindow =
			sample.window.strategy === 'densest-timed-words'
				? {
						strategy: sample.window.strategy,
						start_seconds: sample.window.expected_start_seconds,
						end_seconds: sample.window.expected_end_seconds,
						boundary_policy: 'exclude-crossing-words',
						word_count: sample.window.expected_word_count,
						annotation_member_count: sample.window.annotation_member_count,
						ordered_annotation_members_sha256: sample.window.ordered_annotation_members_sha256,
					}
				: {
						strategy: 'fixed',
						start_seconds: sample.window.start_seconds,
						end_seconds: sample.window.start_seconds + sample.duration_seconds,
						reference_policy: 'listening-required-upstream-transcript-is-unaligned-context-only',
					};
		addSample({
			...sample,
			dataset,
			source_window: sourceWindow,
			reference_path: `references/${sample.id}.txt`,
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
		schema_version: 2,
		corpus_id: selection.corpus_id,
		source_catalog_id: catalog.catalog_id,
		source_catalog_sha256: fileSha256(catalogPath),
		selection_sha256: fileSha256(fixtureSelectionPath),
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
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

test('review attestation records exact audio and reference hashes for two distinct reviewers', () => {
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
		affirmReferenceProtocol: REFERENCE_PROTOCOL_ID,
		acceptReviewedReference: true,
	};
	assert.throws(
		() =>
			recordPublicReviewAttestation({
				...baseOptions,
				reviewerId: 'reviewer-one',
				acceptReviewedReference: false,
			}),
		/--accept-reviewed-reference/,
	);
	const first = recordPublicReviewAttestation({
		...baseOptions,
		reviewerId: 'reviewer-one',
		reviewedAt: '2026-07-17T00:00:00.000Z',
	});
	assert.equal(first.reviewCount, 1);
	assert.equal(first.audioSha256, firstSample.audio_sha256);
	assert.equal(first.referenceSha256, fileSha256(path.join(workspace, firstSample.reference_path)));
	assert.throws(
		() => recordPublicReviewAttestation({ ...baseOptions, reviewerId: 'reviewer-one' }),
		/already attested/,
	);
	const second = recordPublicReviewAttestation({
		...baseOptions,
		reviewerId: 'reviewer-two',
		reviewedAt: '2026-07-17T01:00:00.000Z',
	});
	assert.equal(second.reviewCount, 2);
	assert.throws(
		() => recordPublicReviewAttestation({ ...baseOptions, reviewerId: 'reviewer-three' }),
		/already has the required two reviews/,
	);
	const recorded = JSON.parse(
		fs.readFileSync(path.join(workspace, 'review-attestations.json'), 'utf8'),
	).samples.find((sample) => sample.sample_id === firstSample.id);
	assert.deepEqual(
		recorded.reviewers.map((reviewer) => reviewer.reviewer_id),
		['reviewer-one', 'reviewer-two'],
	);
	assert(recorded.reviewers.every((reviewer) => reviewer.audio_sha256 === first.audioSha256));
	assert(
		recorded.reviewers.every((reviewer) => reviewer.reference_sha256 === first.referenceSha256),
	);
});

test('finalization is blocked until all 66 references have two independent hash-bound reviews', async () => {
	const workspace = temporaryDirectory('muesly-public-finalize-');
	const prepared = writePreparedFixture(workspace);
	const reviews = createReviewTemplate(prepared.samples);
	atomicWriteJson(path.join(workspace, 'review-attestations.json'), reviews);
	const options = {
		workspace,
		catalogPath,
		selectionPath: prepared.fixtureSelectionPath,
		affirmReferenceProtocol: REFERENCE_PROTOCOL_ID,
	};
	const dependencies = { rebuildPreparedOutputs: async () => {} };
	await assert.rejects(
		finalizePublicCorpus(options, dependencies),
		/requires two independent accepted reviews/,
	);
	const preparedById = new Map(prepared.samples.map((sample) => [sample.id, sample]));
	for (const review of reviews.samples) {
		const sample = preparedById.get(review.sample_id);
		const referenceHash = fileSha256(path.join(workspace, sample.reference_path));
		review.reviewers = ['reviewer-one', 'reviewer-two'].map((reviewerId, index) => ({
			reviewer_id: reviewerId,
			reviewed_at: `2026-07-17T0${index}:00:00.000Z`,
			decision: 'accepted',
			affirmed_reference_protocol_id: REFERENCE_PROTOCOL_ID,
			audio_sha256: 'f'.repeat(64),
			reference_sha256: referenceHash,
		}));
	}
	atomicWriteJson(path.join(workspace, 'review-attestations.json'), reviews);
	await assert.rejects(finalizePublicCorpus(options, dependencies), /audio_sha256 does not match/);
	for (const review of reviews.samples) {
		const sample = preparedById.get(review.sample_id);
		for (const reviewer of review.reviewers) reviewer.audio_sha256 = sample.audio_sha256;
	}
	atomicWriteJson(path.join(workspace, 'review-attestations.json'), reviews);
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

	const firstSample = preparedById.get(reviews.samples[0].sample_id);
	const changedReference = path.join(workspace, firstSample.reference_path);
	const originalReference = fs.readFileSync(changedReference);
	fs.appendFileSync(changedReference, 'changed after review\n');
	assert.match(
		validateFinalizedPublicCorpus(options).join('\n'),
		/does not match the current reference/,
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

	firstSample.duration_seconds = 2;
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);
	await assert.rejects(finalizePublicCorpus(options, dependencies), /committed selection/);
	firstSample.duration_seconds = 1;
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);

	const longSample = prepared.samples.find((sample) => sample.duration_seconds === 180);
	assert(longSample, 'fixture must exercise a full 180-second sample');
	const longAudioPath = path.join(workspace, longSample.audio_path);
	const regeneratedBytes = fs.readFileSync(longAudioPath);
	writeFixtureWav(longAudioPath, 31_337, 180);
	longSample.audio_sha256 = fileSha256(longAudioPath);
	const longReview = reviews.samples.find((review) => review.sample_id === longSample.id);
	for (const reviewer of longReview.reviewers) reviewer.audio_sha256 = longSample.audio_sha256;
	atomicWriteJson(path.join(workspace, 'prepared-samples.json'), prepared);
	atomicWriteJson(path.join(workspace, 'review-attestations.json'), reviews);
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
