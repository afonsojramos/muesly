import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256File(filePath) {
	const descriptor = fs.openSync(filePath, 'r');
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		for (;;) {
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		fs.closeSync(descriptor);
	}
	return hash.digest('hex');
}

function requireFile(filePath) {
	if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
		throw new Error(`model artifact file not found: ${filePath}`);
	}
	return filePath;
}

/**
 * Fingerprint the bytes actually consumed by an evaluation model.
 *
 * Whisper is a single GGML file, so the fingerprint is that file's SHA-256.
 * Parakeet is an ONNX artifact set, so its fingerprint is the SHA-256 of a
 * stable filename + per-file-SHA-256 manifest.
 */
export function modelArtifactSha256(provider, model, modelsDirectory) {
	if (provider === 'whisper') {
		return sha256File(requireFile(path.join(modelsDirectory, `ggml-${model}.bin`)));
	}
	if (provider !== 'parakeet') throw new Error(`unsupported model provider: ${provider}`);

	const modelDirectory = path.join(modelsDirectory, 'parakeet', model);
	const int8 = fs.existsSync(path.join(modelDirectory, 'encoder-model.int8.onnx'));
	const filenames = int8
		? ['encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx', 'nemo128.onnx', 'vocab.txt']
		: ['encoder-model.onnx', 'decoder_joint-model.onnx', 'nemo128.onnx', 'vocab.txt'];
	if (!int8 && fs.existsSync(path.join(modelDirectory, 'encoder-model.onnx.data'))) {
		filenames.splice(1, 0, 'encoder-model.onnx.data');
	}
	const manifest = filenames
		.map(
			(filename) => `${filename}\0${sha256File(requireFile(path.join(modelDirectory, filename)))}`,
		)
		.join('\n');
	return createHash('sha256').update(manifest).digest('hex');
}

export function resolveModelsDirectory(modelsDirectory, repositoryRoot) {
	return path.resolve(repositoryRoot, modelsDirectory ?? 'models');
}
