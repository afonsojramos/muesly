import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isCorpusBenchmarkCheckpointName } from './corpus-benchmark-checkpoints.ts';
import {
	assertTaskCheckpoint,
	planCorpusBenchmarkTasks,
	reportIdentityFromCheckpoint,
	resolveBenchmarkBackend,
	sensitiveCheckpointKeyPaths,
	taskReportFilename,
	validateTaskCheckpoint,
} from './corpus-benchmark-plan.ts';
import { corpusFingerprint, loadCorpus, REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { evaluatorRevisionSha256 } from './evaluator-revision.ts';
import { WER_SCORER_ID } from './wer.ts';

const artifact = 'b'.repeat(64);
const executable = 'c'.repeat(64);
const thresholds = {
	max_wer_percent: 10,
	max_hallucinated_words: 2,
};

function digest(value) {
	return createHash('sha256').update(value).digest('hex');
}

function sample({
	id,
	session = id,
	dataset,
	language = 'en',
	noise = 'clean',
	scenario = 'meeting',
	basis = 'participant-consent',
	speakers = 2,
	duration = 20,
	consentedUses = ['asr-benchmarking'],
}) {
	const sessionId = `session-${session}`;
	let provenance;
	if (basis === 'participant-consent') {
		provenance = {
			basis,
			redistribution: 'local-only',
			consent_record_id: `consent-${id}`,
			consent_date: '2026-07-01',
			consented_uses: consentedUses,
		};
	} else if (basis === 'public-license') {
		provenance = {
			basis,
			redistribution: 'local-only',
			source_catalog_id: 'public-corpus-sources-v1',
			source_item_ids: [`source-${id}`],
			transform_id: 'deterministic-test-transform',
		};
	} else {
		provenance = {
			basis,
			redistribution: 'repository',
			source_url: 'https://example.com/public-audio',
			license: 'CC0-1.0',
		};
	}
	return {
		id,
		session_id: sessionId,
		...(dataset === undefined ? {} : { dataset }),
		audio_path: `local-corpus/${sessionId}/${id}.wav`,
		audio_sha256: digest(`audio:${id}`),
		reference_path: `local-corpus/${sessionId}/${id}.txt`,
		reference_sha256: digest(`reference:${id}`),
		duration_seconds: duration,
		language,
		whisper_language: language.split('-')[0].toLowerCase(),
		noise_condition: noise,
		scenario,
		speakers,
		provenance,
	};
}

function corpus(samples) {
	const hasPublicSamples = samples.some(
		(sampleEntry) => sampleEntry.provenance.basis === 'public-license',
	);
	const document = {
		schema_version: 4,
		corpus_id: 'consented-meetings-v1',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		description: 'Validated local consented meetings.',
		distribution: 'local',
		...(hasPublicSamples
			? {
					source_catalog_sha256: '9'.repeat(64),
					preparation: {
						protocol_id: 'muesly-public-asr-preparation-v1',
						source_catalog_id: 'public-corpus-sources-v1',
						selection_sha256: '8'.repeat(64),
						ffmpeg_id: 'ffmpeg-test',
						ffmpeg_sha256: '7'.repeat(64),
						ffmpeg_version: 'ffmpeg test version',
					},
				}
			: {}),
		samples,
	};
	return {
		...document,
		corpus_fingerprint: corpusFingerprint(document),
	};
}

const targets = {
	schema_version: 3,
	target_id: 'multilingual-v1',
	reference_protocol_id: REFERENCE_PROTOCOL_ID,
	coverage_mode: 'language-noise-matrix',
	languages: ['en', 'es'],
	noise_conditions: ['clean', 'office'],
	benchmark_variants: [
		{ provider: 'parakeet', model: 'parakeet-test', backend: 'onnx-cpu' },
		{ provider: 'whisper', model: 'whisper-test', backend: 'metal' },
	],
	min_sessions_per_language_noise_cell: 1,
};

function evaluatorRevisionEntry(targetBackend, overrides = {}) {
	const cargoFeatures =
		targetBackend === 'openblas-cpu'
			? ['openblas']
			: targetBackend === 'coreml-metal'
				? ['coreml']
				: ['metal', 'cuda', 'vulkan', 'hipblas'].includes(targetBackend)
					? [targetBackend]
					: [];
	const revision = {
		schema_version: 1,
		protocol_id: 'muesly-real-run-v1',
		git_commit: '1'.repeat(40),
		cargo_lock_sha256: '2'.repeat(64),
		rustc_vv: [
			'rustc 1.88.0 (6b00bc388 2025-06-23)',
			'binary: rustc',
			'commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc',
			'commit-date: 2025-06-23',
			'host: aarch64-apple-darwin',
			'release: 1.88.0',
			'LLVM version: 20.1.5',
		].join('\n'),
		build_profile: 'release',
		target_triple: 'aarch64-apple-darwin',
		cargo_features: cargoFeatures,
		build_env_sha256: '3'.repeat(64),
		...overrides.revision,
	};
	return {
		revision,
		sha256: overrides.sha256 ?? evaluatorRevisionSha256(revision),
	};
}

function evaluatorRevisionsFor(selectedTargets) {
	return Object.fromEntries(
		selectedTargets.benchmark_variants.map((variant) => [
			variant.backend,
			evaluatorRevisionEntry(variant.backend),
		]),
	);
}

function plannedTask(options = {}) {
	const selectedTargets = options.targets ?? {
		...targets,
		languages: ['en'],
		noise_conditions: ['clean'],
		benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'metal' }],
	};
	return planCorpusBenchmarkTasks({
		corpus: corpus([sample({ id: 'meeting-en-clean' })]),
		targets: selectedTargets,
		thresholds,
		...options,
		evaluatorRevisions: Object.hasOwn(options, 'evaluatorRevisions')
			? options.evaluatorRevisions
			: evaluatorRevisionsFor(selectedTargets),
	})[0];
}

function checkpoint(task = plannedTask(), overrides = {}) {
	const result = {
		sample_id: task.sample_id,
		...(task.dataset === undefined ? {} : { dataset: task.dataset }),
		language: task.language,
		noise_condition: task.noise_condition,
		scenario: task.scenario,
		speakers: task.speakers,
		provenance_basis: task.provenance_basis,
		reference_words: 20,
		word_errors: 1,
		wer_percent: 5,
		hallucinated_words: null,
		passed: true,
		metrics: {
			schema_version: 7,
			provider: task.provider,
			model: task.model,
			backend: task.target_backend,
			operating_system: 'macos',
			architecture: 'aarch64',
			hardware_profile:
				`cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776;runtime_env_sha256=${'d'.repeat(64)}`,
			accelerator: ['metal', 'coreml-metal', 'cuda', 'vulkan', 'hipblas'].includes(
				task.target_backend,
			)
				? `${task.accelerator ?? 'Apple M4 Pro integrated GPU'} [ggml=Metal]`
				: 'none',
			benchmark_executable_sha256: executable,
			audio_sha256: task.audio_sha256,
			audio_duration_seconds: 20,
			decode_seconds: 0.1,
			vad_seconds: 0.2,
			model_download_seconds: 0,
			model_load_seconds: 1,
			inference_seconds: 2,
			inference_rtf: 0.1,
			inference_audio_seconds: 10,
			model_inference_rtf: 0.2,
			measured_total_seconds: 3.3,
			baseline_rss_mb: 100,
			peak_rss_mb: 500,
			peak_rss_delta_mb: 400,
		},
		...overrides.result,
	};
	return {
		schema_version: 11,
		benchmark_task_id: task.task_id,
		corpus_id: task.corpus_id,
		corpus_fingerprint: task.corpus_fingerprint,
		reference_protocol_id: task.reference_protocol_id,
		started_at: '2026-07-16T00:00:00.000Z',
		completed_at: '2026-07-16T00:01:00.000Z',
		wer_scorer: WER_SCORER_ID,
		evaluator_revision: structuredClone(task.evaluator_revision),
		evaluator_revision_sha256: task.evaluator_revision_sha256,
		benchmark_executable_sha256: executable,
		provider: task.provider,
		model: task.model,
		repeat_index: task.repeat_index,
		model_artifact_sha256: artifact,
		thresholds: { ...task.thresholds },
		passed: result.passed,
		results: [result],
		...overrides.report,
	};
}

function legacyCheckpoint(task = plannedTask(), overrides = {}) {
	const report = checkpoint(task, overrides);
	report.schema_version = 10;
	delete report.benchmark_task_id;
	return report;
}

test('maps every canonical target backend to the real-run CLI backend', () => {
	for (const [provider, targetBackend, realRunBackend] of [
		['whisper', 'cpu', 'cpu'],
		['whisper', 'metal', 'metal'],
		['whisper', 'coreml-metal', 'coreml'],
		['whisper', 'cuda', 'cuda'],
		['whisper', 'vulkan', 'vulkan'],
		['whisper', 'hipblas', 'hipblas'],
		['whisper', 'openblas-cpu', 'openblas'],
		['parakeet', 'onnx-cpu', 'cpu'],
	]) {
		assert.deepEqual(resolveBenchmarkBackend(provider, targetBackend), {
			provider,
			targetBackend,
			realRunBackend,
		});
	}
});

test('rejects invalid provider and target-backend combinations', () => {
	for (const [provider, backend] of [
		['parakeet', 'cpu'],
		['parakeet', 'metal'],
		['whisper', 'onnx-cpu'],
		['whisper', 'openblas'],
		['unknown', 'cpu'],
	]) {
		assert.throws(
			() => resolveBenchmarkBackend(provider, backend),
			new RegExp(`${provider}/${backend}`),
		);
	}
});

test('plans schema-2 matrix targets through the compatibility boundary', () => {
	const legacyTargets = { ...targets, schema_version: 2 };
	delete legacyTargets.coverage_mode;
	const tasks = planCorpusBenchmarkTasks({
		corpus: corpus([sample({ id: 'en-clean-a' })]),
		targets: legacyTargets,
		thresholds,
		evaluatorRevisions: evaluatorRevisionsFor(legacyTargets),
	});

	assert.deepEqual(
		tasks.map((task) => `${task.provider}/${task.target_backend}/${task.sample_id}`),
		['parakeet/onnx-cpu/en-clean-a', 'whisper/metal/en-clean-a'],
	);
	assert(tasks.every((task) => task.repeat_index === 1));
});

test('plans from a loaded schema-3 local corpus projection', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-plan-schema3-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const selectedSample = sample({ id: 'en-clean-a' });
	const sessionDirectory = path.join(directory, 'local-corpus', selectedSample.session_id);
	fs.mkdirSync(sessionDirectory, { recursive: true });
	fs.writeFileSync(path.join(sessionDirectory, `${selectedSample.id}.wav`), `audio:${selectedSample.id}`);
	fs.writeFileSync(
		path.join(sessionDirectory, `${selectedSample.id}.txt`),
		`reference:${selectedSample.id}`,
	);
	const previous = {
		schema_version: 3,
		corpus_id: 'consented-meetings-v1',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		description: 'Validated local consented meetings.',
		distribution: 'local',
		samples: [selectedSample],
	};
	const manifestPath = path.join(directory, 'corpus-local.json');
	fs.writeFileSync(manifestPath, JSON.stringify(previous));
	const loaded = loadCorpus(manifestPath);
	const selectedTargets = {
		...targets,
		languages: ['en'],
		noise_conditions: ['clean'],
	};

	const tasks = planCorpusBenchmarkTasks({
		corpus: loaded,
		targets: selectedTargets,
		thresholds,
		evaluatorRevisions: evaluatorRevisionsFor(selectedTargets),
	});

	assert.equal(loaded.schema_version, 4);
	assert.deepEqual(tasks.map((task) => task.sample_id), ['en-clean-a', 'en-clean-a']);
	assert(tasks.every((task) => task.corpus_fingerprint === loaded.corpus_fingerprint));
	assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).schema_version, 3);
});

test('plans only eligible samples in deterministic variant, cell, session, and sample order', () => {
	const samples = [
		sample({ id: 'es-office-b', session: 'z', language: 'es-MX', noise: 'office' }),
		sample({ id: 'en-clean-b', session: 'b' }),
		sample({ id: 'en-office', session: 'a', noise: 'office' }),
		sample({ id: 'es-office-a', session: 'a', language: 'es', noise: 'office' }),
		sample({ id: 'en-clean-a2', session: 'a' }),
		sample({ id: 'en-clean-a1', session: 'a' }),
		sample({ id: 'fr-clean', language: 'fr' }),
		sample({ id: 'public-en', basis: 'public-domain', scenario: 'reading' }),
		sample({ id: 'dictation-en', scenario: 'dictation' }),
	];
	const options = {
		corpus: corpus(samples),
		targets,
		thresholds,
		evaluatorRevisions: evaluatorRevisionsFor(targets),
	};
	const reversed = { ...options, corpus: corpus([...samples].reverse()) };
	const tasks = planCorpusBenchmarkTasks(options);
	const reversedTasks = planCorpusBenchmarkTasks(reversed);

	const orderProjection = (planned) =>
		planned.map(
			({ corpus_fingerprint, task_id, report_filename, ...task }) => task,
		);
	assert.deepEqual(orderProjection(tasks), orderProjection(reversedTasks));
	assert.notEqual(tasks[0].corpus_fingerprint, reversedTasks[0].corpus_fingerprint);
	assert.deepEqual(
		tasks.map((task) => `${task.provider}/${task.target_backend}/${task.sample_id}`),
		[
			'parakeet/onnx-cpu/en-clean-a1',
			'parakeet/onnx-cpu/en-clean-a2',
			'parakeet/onnx-cpu/en-clean-b',
			'parakeet/onnx-cpu/en-office',
			'parakeet/onnx-cpu/es-office-a',
			'parakeet/onnx-cpu/es-office-b',
			'whisper/metal/en-clean-a1',
			'whisper/metal/en-clean-a2',
			'whisper/metal/en-clean-b',
			'whisper/metal/en-office',
			'whisper/metal/es-office-a',
			'whisper/metal/es-office-b',
		],
	);
	assert(tasks.every((task) => task.wer_scorer === WER_SCORER_ID));
	assert(tasks.every((task) => task.reference_protocol_id === REFERENCE_PROTOCOL_ID));
	assert(tasks.every((task) => /^[a-f0-9]{64}$/.test(task.evaluator_revision_sha256)));
	assert(tasks.every((task) => task.evaluator_revision.schema_version === 1));
	assert(tasks.every((task) => task.audio_duration_seconds === 20));
	assert(tasks.every((task) => /^[a-f0-9]{64}$/.test(task.task_id)));
	assert(tasks.every((task) => !task.report_filename.includes('/')));
	assert(tasks.every((task) => !task.report_filename.includes(task.sample_id)));
	assert(tasks.every((task) => task.report_filename.length < 120));
});

test('plans exact samples and repetitions as distinct resumable task identities', () => {
	const selectedTargets = {
		schema_version: 3,
		target_id: 'public-performance-v1',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		coverage_mode: 'explicit-samples',
		sample_ids: ['public-en'],
		benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'metal' }],
		repetitions: 3,
	};
	const tasks = planCorpusBenchmarkTasks({
		corpus: corpus([
			sample({ id: 'ignored-en' }),
			sample({ id: 'public-en', basis: 'public-domain', scenario: 'read-speech', speakers: 1 }),
		]),
		targets: selectedTargets,
		thresholds,
		evaluatorRevisions: evaluatorRevisionsFor(selectedTargets),
	});

	assert.deepEqual(tasks.map((task) => task.sample_id), ['public-en', 'public-en', 'public-en']);
	assert.deepEqual(tasks.map((task) => task.repeat_index), [1, 2, 3]);
	assert.equal(new Set(tasks.map((task) => task.task_id)).size, 3);
	assert.equal(new Set(tasks.map((task) => task.report_filename)).size, 3);
	assert.deepEqual(validateTaskCheckpoint(checkpoint(tasks[1]), tasks[1]), []);
	const cachedFirstRepeat = checkpoint(tasks[0]);
	for (const repeatedTask of tasks.slice(1)) {
		const errors = validateTaskCheckpoint(cachedFirstRepeat, repeatedTask).join('\n');
		assert.match(errors, /checkpoint\.benchmark_task_id must equal/);
		assert.match(errors, /checkpoint\.repeat_index must equal/);
	}
	assert.match(
		validateTaskCheckpoint(
			checkpoint(tasks[1], { report: { repeat_index: 1 } }),
			tasks[1],
		).join('\n'),
		/checkpoint\.repeat_index must equal 2/,
	);
	assert.match(
		validateTaskCheckpoint(legacyCheckpoint(tasks[1]), tasks[1]).join('\n'),
		/schema_version must be 11 for repeated campaign tasks/,
	);
});

test('binds a public dataset and preparation contract into task and checkpoint identity', () => {
	const publicTargets = {
		schema_version: 3,
		target_id: 'public-samples-v1',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		coverage_mode: 'explicit-samples',
		sample_ids: ['meeting-en-fleurs'],
		benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'metal' }],
		repetitions: 1,
	};
	const task = plannedTask({
		corpus: corpus([
			sample({ id: 'meeting-en-fleurs', basis: 'public-license', dataset: 'fleurs' }),
		]),
		targets: publicTargets,
	});
	assert.equal(task.dataset, 'fleurs');
	assert.deepEqual(validateTaskCheckpoint(checkpoint(task), task), []);

	assert.throws(
		() => taskReportFilename({ ...task, dataset: 'ami' }),
		/task\.task_id does not match its benchmark identity/,
	);
	const mismatched = checkpoint(task);
	mismatched.results[0].dataset = 'ami';
	assert.match(
		validateTaskCheckpoint(mismatched, task).join('\n'),
		/checkpoint\.results\[0\]\.dataset must equal "fleurs"/,
	);
});

test('preserves schema-10 checkpoint compatibility only for an unambiguous first repeat', () => {
	const task = plannedTask();
	const legacy = legacyCheckpoint(task);
	delete legacy.repeat_index;
	assert.deepEqual(validateTaskCheckpoint(legacy, task), []);

	const repeated = { ...task, repeat_index: 2 };
	delete repeated.task_id;
	delete repeated.report_filename;
	assert.match(
		validateTaskCheckpoint(legacy, repeated).join('\n'),
		/schema_version must be 11 for repeated campaign tasks/,
	);
});

test('requires a fully valid consented corpus before planning', () => {
	const missingUse = sample({
		id: 'missing-asr-consent',
		consentedUses: [],
	});
	assert.throws(
		() =>
			planCorpusBenchmarkTasks({
				corpus: corpus([missingUse]),
				targets: {
					...targets,
					languages: ['en'],
					noise_conditions: ['clean'],
					benchmark_variants: [
						{ provider: 'whisper', model: 'whisper-test', backend: 'metal' },
					],
				},
				thresholds,
				evaluatorRevisions: { metal: evaluatorRevisionEntry('metal') },
			}),
		/consented_uses must include asr-benchmarking/,
	);

	assert.throws(
		() =>
			planCorpusBenchmarkTasks({
				corpus: corpus([
					sample({ id: 'duplicate-sample', session: 'a' }),
					sample({ id: 'duplicate-sample', session: 'b' }),
				]),
				targets: {
					...targets,
					languages: ['en'],
					noise_conditions: ['clean'],
					benchmark_variants: [
						{ provider: 'whisper', model: 'whisper-test', backend: 'metal' },
					],
				},
				thresholds,
				evaluatorRevisions: { metal: evaluatorRevisionEntry('metal') },
			}),
		/sample 'duplicate-sample'\.id is duplicated/,
	);

	const validCorpus = corpus([sample({ id: 'valid-sample' })]);
	assert.throws(
		() =>
			planCorpusBenchmarkTasks({
				corpus: {
					...validCorpus,
					corpus_fingerprint: 'f'.repeat(64),
				},
				targets: {
					...targets,
					languages: ['en'],
					noise_conditions: ['clean'],
					benchmark_variants: [
						{ provider: 'whisper', model: 'whisper-test', backend: 'metal' },
					],
				},
				thresholds,
				evaluatorRevisions: { metal: evaluatorRevisionEntry('metal') },
			}),
		/corpus_fingerprint does not match/,
	);
	assert.throws(
		() =>
			planCorpusBenchmarkTasks({
				corpus: {
					...validCorpus,
					forbidden_root_field: 'must not be normalized away',
				},
				targets: {
					...targets,
					languages: ['en'],
					noise_conditions: ['clean'],
					benchmark_variants: [
						{ provider: 'whisper', model: 'whisper-test', backend: 'metal' },
					],
				},
				thresholds,
				evaluatorRevisions: { metal: evaluatorRevisionEntry('metal') },
			}),
		/corpus\.forbidden_root_field is not an allowed field/,
	);
});

test('binds every compared sample attribute into the immutable task identity', () => {
	const task = plannedTask();
	const baseline = structuredClone(task);
	delete baseline.task_id;
	delete baseline.report_filename;
	const baselineFilename = taskReportFilename(baseline);

	for (const [field, value] of [
		['sample_revision_sha256', 'f'.repeat(64)],
		['audio_sha256', 'e'.repeat(64)],
		['session_id', 'session-other'],
		['language', 'en-GB'],
		['target_language', 'fr'],
		['noise_condition', 'office'],
		['scenario', 'interview'],
		['speakers', 3],
		['provenance_basis', 'public-domain'],
	]) {
		assert.notEqual(
			taskReportFilename({ ...baseline, [field]: value }),
			baselineFilename,
			field,
		);
	}
});

test('rejects non-portable model names in direct task identities', () => {
	const task = plannedTask();
	for (const model of ['model.', 'con', 'nul.model', 'a'.repeat(129)]) {
		assert.throws(() => taskReportFilename({ ...task, model }), /bounded lowercase model slug/);
		assert.match(
			validateTaskCheckpoint(checkpoint(task), { ...task, model }).join('\n'),
			/invalid benchmark task: benchmark model name must be a bounded lowercase model slug/,
		);
	}
});

test('records explicit accelerators and includes auto versus explicit mode in task identity', () => {
	const automatic = plannedTask();
	const explicit = plannedTask({ accelerators: { metal: 'Apple M4 Pro integrated GPU' } });
	const coreMlTargets = {
		...targets,
		languages: ['en'],
		noise_conditions: ['clean'],
		benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'coreml-metal' }],
	};
	const explicitCoreMl = plannedTask({
		targets: coreMlTargets,
		accelerators: { 'coreml-metal': 'Apple M4 Pro Neural Engine' },
	});

	assert.equal(automatic.accelerator, null);
	assert.equal(explicit.accelerator, 'Apple M4 Pro integrated GPU');
	assert.equal(explicitCoreMl.accelerator, 'Apple M4 Pro Neural Engine');
	assert.notEqual(automatic.task_id, explicit.task_id);
	assert.notEqual(automatic.report_filename, explicit.report_filename);
	assert.throws(
		() => plannedTask({ accelerators: { 'not-a-backend': 'GPU' } }),
		/not a GPU target backend/,
	);
	assert.throws(() => plannedTask({ accelerators: { cpu: 'none' } }), /not a GPU target backend/);
	assert.throws(
		() => plannedTask({ accelerators: { cuda: 'GPU 0' } }),
		/not used by a benchmark variant/,
	);
});

test('rejects duplicate target cells, variants, and unsafe accelerators', () => {
	assert.throws(
		() =>
			plannedTask({
				targets: {
					...targets,
					languages: ['en', 'en'],
				},
			}),
		/targets\.languages contains duplicate 'en'/,
	);
	assert.throws(
		() =>
			plannedTask({
				targets: {
					...targets,
					languages: ['en'],
					noise_conditions: ['clean'],
					benchmark_variants: [
						{ provider: 'whisper', model: 'same', backend: 'cpu' },
						{ provider: 'whisper', model: 'same', backend: 'cpu' },
					],
				},
			}),
		/targets\.benchmark_variants\[1\] duplicates/,
	);
	assert.throws(
		() => plannedTask({ accelerators: { metal: 'GPU; injected' } }),
		/semicolons or line breaks/,
	);
	assert.throws(
		() => plannedTask({ accelerators: { metal: 'none' } }),
		/must identify a real accelerator/,
	);
});

test('requires the complete coverage target schema before planning', () => {
	for (const [name, overrides, expected] of [
		['schema version', { schema_version: 1 }, /targets\.schema_version must be 3/],
		[
			'reference protocol',
			{ reference_protocol_id: 'another-reference-v1' },
			/targets\.reference_protocol_id/,
		],
		['unknown field', { future_option: true }, /targets\.future_option is not an allowed field/],
		['target slug', { target_id: 'Not Valid' }, /targets\.target_id must be a lowercase slug/],
		[
			'language slug',
			{ languages: ['en-US'] },
			/targets\.languages may only contain lowercase slug/,
		],
		[
			'session floor',
			{ min_sessions_per_language_noise_cell: 0 },
			/targets\.min_sessions_per_language_noise_cell must be a positive integer/,
		],
		[
			'provider/backend binding',
			{
				benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'onnx-cpu' }],
			},
			/unsupported reported benchmark backend 'whisper\/onnx-cpu'/,
		],
	]) {
		assert.throws(() => plannedTask({ targets: { ...targets, ...overrides } }), expected, name);
	}
});

test('requires valid evaluator revisions for exactly the selected target backends', () => {
	assert.throws(
		() => plannedTask({ evaluatorRevisions: undefined }),
		/evaluatorRevisions must be an object or Map/,
	);
	assert.throws(
		() => plannedTask({ evaluatorRevisions: {} }),
		/evaluatorRevisions\.metal is required/,
	);
	assert.throws(
		() =>
			plannedTask({
				evaluatorRevisions: {
					metal: evaluatorRevisionEntry('metal'),
					cuda: evaluatorRevisionEntry('cuda'),
				},
			}),
		/evaluator revision backend 'cuda' is not used/,
	);
	assert.throws(
		() =>
			plannedTask({
				evaluatorRevisions: {
					metal: evaluatorRevisionEntry('metal', { sha256: '4'.repeat(64) }),
				},
			}),
		/evaluatorRevisions\.metal\.sha256 must match evaluatorRevisions\.metal\.revision/,
	);
	assert.throws(
		() =>
			plannedTask({
				evaluatorRevisions: {
					metal: {
						...evaluatorRevisionEntry('metal'),
						private_source_path: '/private/evaluator',
					},
				},
			}),
		/evaluatorRevisions\.metal\.private_source_path is not allowed/,
	);
});

test('requires common evaluator source and toolchain provenance across backends', () => {
	const selectedTargets = {
		...targets,
		languages: ['en'],
		noise_conditions: ['clean'],
		benchmark_variants: [
			{ provider: 'whisper', model: 'whisper-test', backend: 'cpu' },
			{ provider: 'whisper', model: 'whisper-test', backend: 'metal' },
		],
	};
	assert.throws(
		() =>
			plannedTask({
				targets: selectedTargets,
				evaluatorRevisions: {
					cpu: evaluatorRevisionEntry('cpu'),
					metal: evaluatorRevisionEntry('metal', {
						revision: { git_commit: '4'.repeat(40) },
					}),
				},
			}),
		/different common field 'git_commit'/,
	);
});

test('binds injected evaluator revisions to the selected backend and target platform', () => {
	const metalTargets = {
		...targets,
		languages: ['en'],
		noise_conditions: ['clean'],
		benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'metal' }],
	};
	assert.throws(
		() =>
			plannedTask({
				targets: metalTargets,
				evaluatorRevisions: {
					metal: evaluatorRevisionEntry('metal', {
						revision: { cargo_features: [] },
					}),
				},
			}),
		/evaluatorRevisions\.metal\.revision\.cargo_features must exactly match whisper\/metal/,
	);

	const cudaTargets = {
		...metalTargets,
		benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'cuda' }],
	};
	assert.throws(
		() =>
			plannedTask({
				targets: cudaTargets,
				evaluatorRevisions: {
					cuda: evaluatorRevisionEntry('cuda'),
				},
			}),
		/evaluatorRevisions\.cuda\.revision\.target_triple is incompatible with whisper\/cuda/,
	);

	const parakeetTargets = {
		...metalTargets,
		benchmark_variants: [{ provider: 'parakeet', model: 'parakeet-test', backend: 'onnx-cpu' }],
	};
	assert.throws(
		() =>
			plannedTask({
				targets: parakeetTargets,
				evaluatorRevisions: {
					'onnx-cpu': evaluatorRevisionEntry('onnx-cpu', {
						revision: { cargo_features: ['metal'] },
					}),
				},
			}),
		/evaluatorRevisions\.onnx-cpu\.revision\.cargo_features must exactly match parakeet\/onnx-cpu/,
	);

	const cpuTargets = {
		...metalTargets,
		benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'cpu' }],
	};
	assert.throws(
		() =>
			plannedTask({
				targets: cpuTargets,
				evaluatorRevisions: {
					cpu: evaluatorRevisionEntry('cpu', {
						revision: { target_triple: 'aarch64-unknown-linux-gnu' },
					}),
				},
			}),
		/unsupported evaluator revision target triple 'aarch64-unknown-linux-gnu'/,
	);
});

test('plans every supported target/backend revision with exact features', () => {
	for (const [provider, backend, targetTriple] of [
		['whisper', 'cpu', 'aarch64-apple-darwin'],
		['whisper', 'metal', 'aarch64-apple-darwin'],
		['whisper', 'coreml-metal', 'aarch64-apple-darwin'],
		['parakeet', 'onnx-cpu', 'aarch64-apple-darwin'],
		['whisper', 'cpu', 'x86_64-apple-darwin'],
		['whisper', 'metal', 'x86_64-apple-darwin'],
		['whisper', 'coreml-metal', 'x86_64-apple-darwin'],
		['whisper', 'openblas-cpu', 'x86_64-apple-darwin'],
		['parakeet', 'onnx-cpu', 'x86_64-apple-darwin'],
		['whisper', 'cpu', 'x86_64-unknown-linux-gnu'],
		['whisper', 'cuda', 'x86_64-unknown-linux-gnu'],
		['whisper', 'vulkan', 'x86_64-unknown-linux-gnu'],
		['whisper', 'openblas-cpu', 'x86_64-unknown-linux-gnu'],
		['whisper', 'hipblas', 'x86_64-unknown-linux-gnu'],
		['parakeet', 'onnx-cpu', 'x86_64-unknown-linux-gnu'],
		['whisper', 'cpu', 'x86_64-pc-windows-msvc'],
		['whisper', 'cuda', 'x86_64-pc-windows-msvc'],
		['whisper', 'vulkan', 'x86_64-pc-windows-msvc'],
		['whisper', 'openblas-cpu', 'x86_64-pc-windows-msvc'],
		['parakeet', 'onnx-cpu', 'x86_64-pc-windows-msvc'],
	]) {
		const selectedTargets = {
			...targets,
			languages: ['en'],
			noise_conditions: ['clean'],
			benchmark_variants: [{ provider, model: 'test-model', backend }],
		};
			const task = plannedTask({
				targets: selectedTargets,
				accelerators:
					['metal', 'coreml-metal', 'cuda', 'vulkan', 'hipblas'].includes(backend) &&
					targetTriple !== 'aarch64-apple-darwin'
						? { [backend]: 'Test accelerator' }
						: {},
				evaluatorRevisions: {
					[backend]: evaluatorRevisionEntry(backend, {
						revision: { target_triple: targetTriple },
				}),
			},
		});
			assert.equal(task.provider, provider);
			assert.equal(task.target_backend, backend);
			assert.equal(task.evaluator_revision.target_triple, targetTriple);
			assert(
				isCorpusBenchmarkCheckpointName(
					taskReportFilename(task, {
						model_artifact_sha256: artifact,
						operating_system: 'test-os',
						architecture: 'test-architecture',
						hardware_profile:
							`cpu=Test CPU;logical_cpus=1;memory_bytes=1;runtime_env_sha256=${'d'.repeat(64)}`,
						accelerator: 'test-accelerator',
						benchmark_executable_sha256: executable,
					}),
				),
				`${provider}/${backend}`,
			);
		}
});

test('requires explicit accelerator identities when the target cannot derive one', () => {
	for (const [backend, targetTriple] of [
		['metal', 'x86_64-apple-darwin'],
		['coreml-metal', 'x86_64-apple-darwin'],
		['cuda', 'x86_64-unknown-linux-gnu'],
		['vulkan', 'x86_64-pc-windows-msvc'],
		['hipblas', 'x86_64-unknown-linux-gnu'],
	]) {
		const selectedTargets = {
			...targets,
			languages: ['en'],
			noise_conditions: ['clean'],
			benchmark_variants: [{ provider: 'whisper', model: 'test-model', backend }],
		};
		assert.throws(
			() =>
				plannedTask({
					targets: selectedTargets,
					evaluatorRevisions: {
						[backend]: evaluatorRevisionEntry(backend, {
							revision: { target_triple: targetTriple },
						}),
					},
				}),
			new RegExp(`accelerators\\.${backend.replace('-', '\\-')} is required`),
		);
	}
});

test('includes evaluator revision provenance in the immutable task identity', () => {
	const baseline = plannedTask();
	const changedRevision = evaluatorRevisionEntry('metal', {
		revision: { git_commit: '4'.repeat(40) },
	});
	const changed = plannedTask({ evaluatorRevisions: { metal: changedRevision } });

	assert.notEqual(changed.evaluator_revision_sha256, baseline.evaluator_revision_sha256);
	assert.notEqual(changed.task_id, baseline.task_id);
	assert.notEqual(changed.report_filename, baseline.report_filename);
	assert.throws(
		() =>
			taskReportFilename({
				...baseline,
				evaluator_revision: changed.evaluator_revision,
				evaluator_revision_sha256: changed.evaluator_revision_sha256,
			}),
		/task\.task_id does not match/,
	);
});

test('generates stable short filenames and adds an actual artifact/hardware suffix', () => {
	const task = plannedTask();
	const report = checkpoint(task);
	const identity = reportIdentityFromCheckpoint(report);
	const base = taskReportFilename(task);
	const actual = taskReportFilename(task, identity);

	assert.equal(base, task.report_filename);
	assert.equal(actual, taskReportFilename(task, identity));
	assert.notEqual(actual, base);
	assert(!actual.includes('/'));
	assert(!actual.includes(task.sample_id));
	assert(actual.length < 120);
	assert.notEqual(
		actual,
		taskReportFilename(task, {
			...identity,
			model_artifact_sha256: 'c'.repeat(64),
		}),
	);
	assert.notEqual(
		actual,
		taskReportFilename(task, {
			...identity,
				hardware_profile:
					`cpu=Apple M1;logical_cpus=8;memory_bytes=17179869184;runtime_env_sha256=${'d'.repeat(64)}`,
		}),
	);
	assert.notEqual(
		actual,
		taskReportFilename(task, {
			...identity,
			benchmark_executable_sha256: 'd'.repeat(64),
		}),
	);
	assert.match(actual, /^run-whisper-metal-[a-f0-9]{16}-[a-f0-9]{16}\.run\.json$/);
});

test('accepts an exact single-result checkpoint and optional artifact pin', () => {
	const task = plannedTask({ accelerators: { metal: 'Apple M4 Pro integrated GPU' } });
	const report = checkpoint(task);

	assert.deepEqual(validateTaskCheckpoint(report, task), []);
	assert.deepEqual(
		validateTaskCheckpoint(report, task, {
			expectedModelArtifactSha256: artifact,
		}),
		[],
	);
	assert.equal(assertTaskCheckpoint(report, task), report);
});

test('requires explicit accelerator checkpoints to include the detected ggml device', () => {
	const task = plannedTask({ accelerators: { metal: 'Apple M4 Pro integrated GPU' } });
	const report = checkpoint(task);
	report.results[0].metrics.accelerator = task.accelerator;

	assert.match(
		validateTaskCheckpoint(report, task).join('\n'),
		/must bind the configured accelerator .* to a detected ggml device/,
	);
});

test('requires checkpoint evaluator provenance to match the planned task exactly', () => {
	const task = plannedTask();
	const changed = evaluatorRevisionEntry('metal', {
		revision: { git_commit: '4'.repeat(40) },
	});
	const report = checkpoint(task, {
		report: {
			evaluator_revision: changed.revision,
			evaluator_revision_sha256: changed.sha256,
		},
	});
	const errors = validateTaskCheckpoint(report, task).join('\n');

	assert.match(errors, /checkpoint\.evaluator_revision_sha256/);
	assert.match(errors, /checkpoint\.evaluator_revision must match task\.evaluator_revision/);

	const internallyMismatched = checkpoint(task, {
		report: { evaluator_revision: changed.revision },
	});
	assert.match(
		validateTaskCheckpoint(internallyMismatched, task).join('\n'),
		/evaluator_revision_sha256 must match checkpoint\.evaluator_revision/,
	);
});

test('requires run schema 10 or 11, metrics schema 7, and exact executable and audio identities', () => {
	const task = plannedTask();
	const staleSchema = checkpoint(task, { report: { schema_version: 9 } });
	assert.match(validateTaskCheckpoint(staleSchema, task).join('\n'), /schema_version must be 10 or 11/);

	const staleMetrics = checkpoint(task);
	staleMetrics.results[0].metrics.schema_version = 4;
	assert.match(
		validateTaskCheckpoint(staleMetrics, task).join('\n'),
		/metrics\.schema_version must be 7/,
	);

	const mismatchedExecutable = checkpoint(task);
	mismatchedExecutable.results[0].metrics.benchmark_executable_sha256 = 'd'.repeat(64);
	assert.match(
		validateTaskCheckpoint(mismatchedExecutable, task).join('\n'),
		/metrics\.benchmark_executable_sha256 must match checkpoint\.benchmark_executable_sha256/,
	);
	assert.throws(
		() => reportIdentityFromCheckpoint(mismatchedExecutable),
		/benchmark executable digest must match/,
	);

	const mismatchedAudio = checkpoint(task);
	mismatchedAudio.results[0].metrics.audio_sha256 = 'd'.repeat(64);
	assert.match(
		validateTaskCheckpoint(mismatchedAudio, task).join('\n'),
		/metrics\.audio_sha256/,
	);
});

test('rejects a task whose scorer or digest was altered after planning', () => {
	const task = plannedTask();
	assert.match(
		validateTaskCheckpoint(checkpoint(task), {
			...task,
			wer_scorer: 'different-scorer-v1',
		}).join('\n'),
		/invalid benchmark task: task\.wer_scorer/,
	);
	assert.match(
		validateTaskCheckpoint(checkpoint(task), {
			...task,
			task_id: 'c'.repeat(64),
		}).join('\n'),
		/task\.task_id does not match/,
	);
});

test('validates every task identity and sample metadata field', () => {
	const task = plannedTask({ accelerators: { metal: 'Apple M4 Pro integrated GPU' } });
	const cases = [
		[{ report: { corpus_id: 'other' } }, /checkpoint\.corpus_id/],
		[{ report: { corpus_fingerprint: 'c'.repeat(64) } }, /checkpoint\.corpus_fingerprint/],
		[{ report: { wer_scorer: 'another-scorer-v1' } }, /checkpoint\.wer_scorer/],
		[{ report: { provider: 'parakeet' } }, /checkpoint\.provider/],
		[{ report: { model: 'other-model' } }, /checkpoint\.model/],
		[
			{ report: { thresholds: { ...thresholds, max_wer_percent: 20 } } },
			/thresholds\.max_wer_percent/,
		],
		[{ result: { sample_id: 'other-sample' } }, /results\[0\]\.sample_id/],
		[{ result: { language: 'es' } }, /results\[0\]\.language/],
		[{ result: { noise_condition: 'office' } }, /results\[0\]\.noise_condition/],
		[{ result: { scenario: 'dictation' } }, /results\[0\]\.scenario/],
		[{ result: { speakers: 4 } }, /results\[0\]\.speakers/],
		[{ result: { provenance_basis: 'public-domain' } }, /provenance_basis/],
	];
	for (const [overrides, expected] of cases) {
		assert.match(validateTaskCheckpoint(checkpoint(task, overrides), task).join('\n'), expected);
	}
});

test('requires one result, matching pass state, backend, provider/model, and explicit accelerator', () => {
	const task = plannedTask({ accelerators: { metal: 'Apple M4 Pro integrated GPU' } });
	const twoResults = checkpoint(task);
	twoResults.results.push(structuredClone(twoResults.results[0]));
	assert.match(validateTaskCheckpoint(twoResults, task).join('\n'), /exactly one result/);

	const mismatchedPass = checkpoint(task, { report: { passed: false } });
	assert.match(validateTaskCheckpoint(mismatchedPass, task).join('\n'), /checkpoint\.passed/);

	for (const [field, value] of [
		['provider', 'parakeet'],
		['model', 'another-model'],
		['backend', 'cpu'],
		['accelerator', 'Another GPU'],
	]) {
		const report = checkpoint(task);
		report.results[0].metrics[field] = value;
		assert.match(validateTaskCheckpoint(report, task).join('\n'), new RegExp(`metrics\\.${field}`));
	}

	const mismatchedDuration = checkpoint(task);
	mismatchedDuration.results[0].metrics.audio_duration_seconds = 21;
	assert.match(
		validateTaskCheckpoint(mismatchedDuration, task).join('\n'),
		/audio_duration_seconds must match the planned corpus sample/,
	);
});

test('enforces an optional model artifact digest', () => {
	const task = plannedTask();
	assert.match(
		validateTaskCheckpoint(checkpoint(task), task, {
			expectedModelArtifactSha256: 'c'.repeat(64),
		}).join('\n'),
		/model_artifact_sha256/,
	);
	assert.match(
		validateTaskCheckpoint(checkpoint(task), task, {
			expectedModelArtifactSha256: 'invalid',
		}).join('\n'),
		/expectedModelArtifactSha256/,
	);
});

test('recursively rejects transcript, hypothesis, reference payload, and consent keys', () => {
	const safe = checkpoint();
	assert.deepEqual(sensitiveCheckpointKeyPaths(safe), []);

	const unsafe = checkpoint();
	unsafe.debug = {
		transcript_text: 'private words',
		nested: [
			{ hypothesis: 'private words' },
			{ reference_path: '/private/reference.txt' },
			{ consentRecordId: 'consent-private' },
			{ reference_words: 'private words disguised as a count' },
			{ reference_protocol_id: 'nested protocol field' },
		],
	};
	assert.deepEqual(sensitiveCheckpointKeyPaths(unsafe), [
		'checkpoint.debug.transcript_text',
		'checkpoint.debug.nested[0].hypothesis',
		'checkpoint.debug.nested[1].reference_path',
		'checkpoint.debug.nested[2].consentRecordId',
		'checkpoint.debug.nested[3].reference_words',
		'checkpoint.debug.nested[4].reference_protocol_id',
	]);
	const errors = validateTaskCheckpoint(unsafe, plannedTask());
	for (const path of sensitiveCheckpointKeyPaths(unsafe)) {
		assert(errors.some((error) => error.includes(path) && /forbidden sensitive/.test(error)));
	}
});

test('rejects unknown fields even when their names do not look sensitive', () => {
	const task = plannedTask();
	const report = checkpoint(task);
	report.debug = { text: 'private words' };
	report.thresholds.mode = 'custom';
	report.results[0].metadata = { text: 'private words' };
	report.results[0].metrics.driver_notes = 'private words';

	assert.match(
		validateTaskCheckpoint(report, task).join('\n'),
		/checkpoint\.debug is not an allowed checkpoint field/,
	);
	assert.match(
		validateTaskCheckpoint(report, task).join('\n'),
		/checkpoint\.thresholds\.mode is not an allowed checkpoint field/,
	);
	assert.match(
		validateTaskCheckpoint(report, task).join('\n'),
		/checkpoint\.results\[0\]\.metadata is not an allowed checkpoint field/,
	);
	assert.match(
		validateTaskCheckpoint(report, task).join('\n'),
		/metrics\.driver_notes is not an allowed checkpoint field/,
	);
});

test('rejects contradictory WER, timing, memory, timestamp, and meeting result shapes', () => {
	const task = plannedTask();
	const report = checkpoint(task, {
		report: {
			started_at: '2026-07-16T00:02:00.000Z',
			completed_at: '2026-07-16T00:01:00.000Z',
		},
	});
	report.results[0].wer_percent = 6;
	report.results[0].metrics.inference_rtf = 0.2;
	report.results[0].metrics.inference_audio_seconds = 21;
	report.results[0].metrics.model_inference_rtf = 0.3;
	report.results[0].metrics.peak_rss_delta_mb = 399;

	const errors = validateTaskCheckpoint(report, task).join('\n');
	assert.match(errors, /completed_at must not precede/);
	assert.match(errors, /wer_percent does not match/);
	assert.match(errors, /inference_rtf does not match/);
	assert.match(errors, /inference_audio_seconds must not materially exceed source duration/);
	assert.match(errors, /model_inference_rtf does not match/);
	assert.match(errors, /peak_rss_delta_mb does not match/);

	const hallucination = checkpoint(task, {
		result: {
			reference_words: null,
			word_errors: null,
			wer_percent: null,
			hallucinated_words: 0,
		},
	});
	assert.match(
		validateTaskCheckpoint(hallucination, task).join('\n'),
		/must contain WER counts for a meeting sample/,
	);
});

test('rejects a passing checkpoint above its WER threshold', () => {
	const task = plannedTask();
	const report = checkpoint(task, {
		result: {
			word_errors: 3,
			wer_percent: 15,
			passed: true,
		},
	});
	assert.match(
		validateTaskCheckpoint(report, task).join('\n'),
		/passed cannot be true above the WER threshold/,
	);
});

test('delegates the evolving report schema to validateRunReport', () => {
	const task = plannedTask();
	const report = checkpoint(task, { report: { schema_version: 7 } });
	assert.match(validateTaskCheckpoint(report, task).join('\n'), /schema_version must be 10 or 11/);
});
