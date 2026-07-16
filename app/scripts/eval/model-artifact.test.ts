import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { modelArtifactSha256, resolveModelsDirectory } from './model-artifact.ts';

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

test('fingerprints the exact Whisper model bytes', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-artifact-'));
	fs.writeFileSync(path.join(directory, 'ggml-test.bin'), 'whisper bytes');
	assert.equal(
		modelArtifactSha256('whisper', 'test', directory),
		'd83a8c24e2e979dfebef2b73e8eeba84bb52b03f5291c655a481ccacc9dccc48',
	);
	fs.rmSync(directory, { recursive: true, force: true });
});

test('fingerprints every file in the selected Parakeet artifact set', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-artifact-'));
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
	const before = modelArtifactSha256('parakeet', 'test', directory);
	fs.appendFileSync(path.join(modelDirectory, 'vocab.txt'), 'changed');
	assert.notEqual(modelArtifactSha256('parakeet', 'test', directory), before);
	fs.rmSync(directory, { recursive: true, force: true });
});
