import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	coreMlEncoderBundlePath,
	modelArtifactSha256,
	primaryModelArtifactSha256,
	resolveModelsDirectory,
	stageModelArtifactSnapshot,
	validateBenchmarkModelName,
} from './model-artifact.ts';

test('resolves relative model directories from the Cargo working directory', () => {
	const repositoryRoot = path.resolve('repo-root');
	const absoluteModels = path.resolve('absolute-models');
	assert.equal(
		resolveModelsDirectory('shared-models', repositoryRoot),
		path.join(repositoryRoot, 'shared-models'),
	);
	assert.equal(resolveModelsDirectory(absoluteModels, repositoryRoot), absoluteModels);
	assert.equal(resolveModelsDirectory(null, repositoryRoot), path.join(repositoryRoot, 'models'));
});

test('rejects non-portable model names before creating an artifact snapshot', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-path-escape-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const snapshotRoot = path.join(directory, 'snapshot');
	for (const model of [
		'../../escaped',
		'..\\..\\escaped',
		'/absolute',
		'C:\\absolute',
		'model.',
		'model..',
		'con',
		'nul.model',
		'com1.onnx',
		'lpt9.extra',
	]) {
		assert.throws(() => validateBenchmarkModelName(model), /bounded lowercase model slug/);
		assert.throws(
			() =>
				stageModelArtifactSnapshot(
					'parakeet',
					model,
					path.join(directory, 'models'),
					'onnx-cpu',
					snapshotRoot,
					'a'.repeat(64),
				),
			/bounded lowercase model slug/,
		);
		assert(!fs.existsSync(snapshotRoot));
	}
});

test('accepts every shipped model name and enforces the 128-character bound', () => {
	for (const model of [
		'tiny',
		'base',
		'small',
		'medium',
		'large-v3-turbo',
		'large-v3',
		'tiny-q5_1',
		'base-q5_1',
		'small-q5_1',
		'medium-q5_0',
		'large-v3-turbo-q5_0',
		'large-v3-q5_0',
		'parakeet-tdt-0.6b-v2-int8',
		'parakeet-tdt-0.6b-v3-int8',
		'a'.repeat(128),
	]) {
		assert.equal(validateBenchmarkModelName(model), model);
	}
	assert.throws(() => validateBenchmarkModelName('a'.repeat(129)), /bounded lowercase model slug/);
});

test('fingerprints the exact Whisper model bytes', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-artifact-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.writeFileSync(path.join(directory, 'ggml-test.bin'), 'whisper bytes');
	assert.equal(
		modelArtifactSha256('whisper', 'test', directory, 'cpu'),
		'd83a8c24e2e979dfebef2b73e8eeba84bb52b03f5291c655a481ccacc9dccc48',
	);
	assert.equal(
		primaryModelArtifactSha256('whisper', 'test', directory),
		'd83a8c24e2e979dfebef2b73e8eeba84bb52b03f5291c655a481ccacc9dccc48',
	);
	assert.equal(primaryModelArtifactSha256('parakeet', 'test', directory), null);
});

test('derives the Core ML encoder bundle exactly like whisper.cpp', () => {
	assert.equal(
		coreMlEncoderBundlePath('/models/ggml-large-v3-turbo-q5_0.bin'),
		'/models/ggml-large-v3-turbo-encoder.mlmodelc',
	);
	assert.equal(
		coreMlEncoderBundlePath('/models/ggml-large-v3-turbo.bin'),
		'/models/ggml-large-v3-turbo-encoder.mlmodelc',
	);
	assert.equal(
		coreMlEncoderBundlePath('/models/ggml-test-q12_0.bin'),
		'/models/ggml-test-q12_0-encoder.mlmodelc',
	);
});

test('fingerprints the complete GGML and Core ML artifact set', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-artifact-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const modelPath = path.join(directory, 'ggml-test-q5_0.bin');
	const bundlePath = path.join(directory, 'ggml-test-encoder.mlmodelc');
	const weightsDirectory = path.join(bundlePath, 'weights');
	fs.writeFileSync(modelPath, 'whisper bytes');
	fs.mkdirSync(weightsDirectory, { recursive: true });
	fs.writeFileSync(path.join(bundlePath, 'model.mil'), 'program');
	fs.writeFileSync(path.join(weightsDirectory, 'weight.bin'), 'weights');

	const before = modelArtifactSha256('whisper', 'test-q5_0', directory, 'coreml-metal');
	fs.appendFileSync(path.join(weightsDirectory, 'weight.bin'), ' changed');
	const after = modelArtifactSha256('whisper', 'test-q5_0', directory, 'coreml-metal');
	assert.notEqual(after, before);
	assert.equal(
		modelArtifactSha256('whisper', 'test-q5_0', directory, 'metal'),
		modelArtifactSha256('whisper', 'test-q5_0', directory, 'cpu'),
	);
});

test('requires the exact Core ML bundle for Core ML measurements', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-artifact-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.writeFileSync(path.join(directory, 'ggml-test-q5_0.bin'), 'whisper bytes');
	fs.mkdirSync(path.join(directory, 'ggml-test-q5_0-encoder.mlmodelc'));
	assert.throws(
		() => modelArtifactSha256('whisper', 'test-q5_0', directory, 'coreml-metal'),
		/model artifact directory must be a real directory/,
	);
});

test('rejects aliased Core ML bundle entries', async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-artifact-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const modelPath = path.join(directory, 'ggml-test.bin');
	const bundlePath = path.join(directory, 'ggml-test-encoder.mlmodelc');
	fs.writeFileSync(modelPath, 'whisper bytes');

	await t.test('hard-linked file', () => {
		const target = path.join(directory, 'target.bin');
		fs.writeFileSync(target, 'weights');
		fs.mkdirSync(bundlePath);
		fs.linkSync(target, path.join(bundlePath, 'weight.bin'));
		assert.throws(
			() => modelArtifactSha256('whisper', 'test', directory, 'coreml-metal'),
			/regular single-link file/,
		);
		fs.rmSync(bundlePath, { recursive: true });
	});

	await t.test('symbolic-link bundle', (t) => {
		if (process.platform === 'win32') return t.skip('symbolic links are not portable on Windows');
		const target = path.join(directory, 'real-bundle');
		fs.mkdirSync(target);
		fs.writeFileSync(path.join(target, 'weight.bin'), 'weights');
		fs.symlinkSync(target, bundlePath, 'dir');
		assert.throws(
			() => modelArtifactSha256('whisper', 'test', directory, 'coreml-metal'),
			/must be a real directory/,
		);
		fs.unlinkSync(bundlePath);
	});

	await t.test('symbolic-link entry', (t) => {
		if (process.platform === 'win32') return t.skip('symbolic links are not portable on Windows');
		fs.mkdirSync(bundlePath);
		fs.symlinkSync(path.join(directory, 'target.bin'), path.join(bundlePath, 'weight.bin'));
		assert.throws(
			() => modelArtifactSha256('whisper', 'test', directory, 'coreml-metal'),
			/cannot be symbolic links/,
		);
	});
});

test('fingerprints every file in the selected Parakeet artifact set', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-artifact-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const modelDirectory = path.join(directory, 'parakeet', 'test');
	fs.mkdirSync(modelDirectory, { recursive: true });
	for (const filename of [
		'encoder-model.int8.onnx',
		'decoder_joint-model.int8.onnx',
		'nemo128.onnx',
		'vocab.txt',
	]) {
		fs.writeFileSync(path.join(modelDirectory, filename), filename);
	}
	const before = modelArtifactSha256('parakeet', 'test', directory, 'onnx-cpu');
	fs.appendFileSync(path.join(modelDirectory, 'vocab.txt'), 'changed');
	assert.notEqual(modelArtifactSha256('parakeet', 'test', directory, 'onnx-cpu'), before);
});

test('stages complete Whisper, Core ML, and Parakeet artifact snapshots', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-snapshot-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const modelsDirectory = path.join(directory, 'models');
	fs.mkdirSync(modelsDirectory);

	const whisperPath = path.join(modelsDirectory, 'ggml-whisper.bin');
	fs.writeFileSync(whisperPath, 'whisper bytes');
	const whisperSha256 = modelArtifactSha256('whisper', 'whisper', modelsDirectory, 'cpu');
	const whisperSnapshot = stageModelArtifactSnapshot(
		'whisper',
		'whisper',
		modelsDirectory,
		'cpu',
		path.join(directory, 'whisper-snapshot'),
		whisperSha256,
	);
	assert.equal(whisperSnapshot.sha256, whisperSha256);

	const coreMlModelPath = path.join(modelsDirectory, 'ggml-coreml-q5_0.bin');
	const coreMlBundlePath = path.join(modelsDirectory, 'ggml-coreml-encoder.mlmodelc');
	fs.writeFileSync(coreMlModelPath, 'Core ML GGML bytes');
	fs.mkdirSync(path.join(coreMlBundlePath, 'weights'), { recursive: true });
	fs.writeFileSync(path.join(coreMlBundlePath, 'model.mil'), 'Core ML program');
	fs.writeFileSync(path.join(coreMlBundlePath, 'weights', 'weight.bin'), 'Core ML weights');
	const coreMlSha256 = modelArtifactSha256(
		'whisper',
		'coreml-q5_0',
		modelsDirectory,
		'coreml-metal',
	);
	const coreMlSnapshot = stageModelArtifactSnapshot(
		'whisper',
		'coreml-q5_0',
		modelsDirectory,
		'coreml-metal',
		path.join(directory, 'coreml-snapshot'),
		coreMlSha256,
	);
	assert.equal(coreMlSnapshot.sha256, coreMlSha256);
	assert(
		fs.existsSync(
			path.join(
				coreMlSnapshot.modelsDirectory,
				'ggml-coreml-encoder.mlmodelc',
				'weights',
				'weight.bin',
			),
		),
	);

	const parakeetDirectory = path.join(modelsDirectory, 'parakeet', 'parakeet-test');
	fs.mkdirSync(parakeetDirectory, { recursive: true });
	for (const filename of [
		'encoder-model.int8.onnx',
		'decoder_joint-model.int8.onnx',
		'nemo128.onnx',
		'vocab.txt',
	]) {
		fs.writeFileSync(path.join(parakeetDirectory, filename), filename);
	}
	const parakeetSha256 = modelArtifactSha256(
		'parakeet',
		'parakeet-test',
		modelsDirectory,
		'onnx-cpu',
	);
	const parakeetSnapshot = stageModelArtifactSnapshot(
		'parakeet',
		'parakeet-test',
		modelsDirectory,
		'onnx-cpu',
		path.join(directory, 'parakeet-snapshot'),
		parakeetSha256,
	);
	assert.equal(parakeetSnapshot.sha256, parakeetSha256);

	fs.writeFileSync(whisperPath, 'changed source bytes');
	fs.writeFileSync(path.join(coreMlBundlePath, 'weights', 'weight.bin'), 'changed source weights');
	fs.writeFileSync(path.join(parakeetDirectory, 'vocab.txt'), 'changed source vocabulary');
	assert.equal(
		modelArtifactSha256('whisper', 'whisper', whisperSnapshot.modelsDirectory, 'cpu'),
		whisperSha256,
	);
	assert.equal(
		modelArtifactSha256('whisper', 'coreml-q5_0', coreMlSnapshot.modelsDirectory, 'coreml-metal'),
		coreMlSha256,
	);
	assert.equal(
		modelArtifactSha256('parakeet', 'parakeet-test', parakeetSnapshot.modelsDirectory, 'onnx-cpu'),
		parakeetSha256,
	);
});

test('rejects a model file transiently replaced only while its snapshot is copied', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-snapshot-attack-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const modelsDirectory = path.join(directory, 'models');
	const modelDirectory = path.join(modelsDirectory, 'parakeet', 'test');
	fs.mkdirSync(modelDirectory, { recursive: true });
	for (const filename of [
		'encoder-model.int8.onnx',
		'decoder_joint-model.int8.onnx',
		'nemo128.onnx',
		'vocab.txt',
	]) {
		fs.writeFileSync(path.join(modelDirectory, filename), `exact ${filename}`);
	}
	const expectedSha256 = modelArtifactSha256('parakeet', 'test', modelsDirectory, 'onnx-cpu');
	const attackedSource = path.join(modelDirectory, 'encoder-model.int8.onnx');
	const heldSource = path.join(modelDirectory, 'held-encoder.onnx');
	let attacked = false;

	assert.throws(
		() =>
			stageModelArtifactSnapshot(
				'parakeet',
				'test',
				modelsDirectory,
				'onnx-cpu',
				path.join(directory, 'snapshot'),
				expectedSha256,
				{
					copyFileSnapshotImpl: (sourcePath, destinationPath, options) => {
						if (!attacked && sourcePath === attackedSource) {
							attacked = true;
							fs.renameSync(sourcePath, heldSource);
							try {
								fs.writeFileSync(sourcePath, 'transient malicious model bytes');
								fs.copyFileSync(sourcePath, destinationPath);
								fs.chmodSync(destinationPath, options.mode);
							} finally {
								fs.rmSync(sourcePath, { force: true });
								fs.renameSync(heldSource, sourcePath);
							}
							return;
						}
						fs.copyFileSync(sourcePath, destinationPath);
						fs.chmodSync(destinationPath, options.mode);
					},
				},
			),
		/model artifact snapshot does not match the expected SHA-256/,
	);
	assert(attacked);
	assert.equal(
		modelArtifactSha256('parakeet', 'test', modelsDirectory, 'onnx-cpu'),
		expectedSha256,
	);
	assert(!fs.existsSync(path.join(directory, 'snapshot')));
});

test('rejects aliased model artifact files', async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-artifact-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const target = path.join(directory, 'target.bin');
	const model = path.join(directory, 'ggml-test.bin');
	fs.writeFileSync(target, 'model bytes');

	await t.test('hard link', () => {
		fs.linkSync(target, model);
		assert.throws(
			() => modelArtifactSha256('whisper', 'test', directory, 'cpu'),
			/regular single-link file/,
		);
		fs.unlinkSync(model);
	});

	await t.test('symbolic link', (t) => {
		if (process.platform === 'win32') return t.skip('symbolic links are not portable on Windows');
		fs.symlinkSync(target, model);
		assert.throws(
			() => modelArtifactSha256('whisper', 'test', directory, 'cpu'),
			/regular single-link file/,
		);
	});
});
