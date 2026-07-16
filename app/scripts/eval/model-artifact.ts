import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { copyAttestedFileSnapshot } from './artifact-snapshot.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BENCHMARK_MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function validateBenchmarkModelName(model) {
	if (typeof model !== 'string' || !BENCHMARK_MODEL_NAME_PATTERN.test(model)) {
		throw new Error('benchmark model name must be a bounded lowercase model slug');
	}
	return model;
}

function entryAt(filePath) {
	return fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
}

function isSingleLinkRegularFile(status) {
	return status?.isFile() && !status.isSymbolicLink() && status.nlink === 1n;
}

function isDirectory(status) {
	return status?.isDirectory() && !status.isSymbolicLink();
}

function sameFileSnapshot(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function sha256File(filePath) {
	const initial = entryAt(filePath);
	if (!isSingleLinkRegularFile(initial)) {
		throw new Error(`model artifact must be a regular single-link file: ${filePath}`);
	}
	let descriptor;
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	try {
		descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (!isSingleLinkRegularFile(opened) || !sameFileSnapshot(initial, opened)) {
			throw new Error(`model artifact changed while it was being opened: ${filePath}`);
		}
		for (;;) {
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
		const finalDescriptor = fs.fstatSync(descriptor, { bigint: true });
		const finalPath = entryAt(filePath);
		if (
			!isSingleLinkRegularFile(finalDescriptor) ||
			!isSingleLinkRegularFile(finalPath) ||
			!sameFileSnapshot(opened, finalDescriptor) ||
			!sameFileSnapshot(finalDescriptor, finalPath)
		) {
			throw new Error(`model artifact changed while it was being hashed: ${filePath}`);
		}
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
	return hash.digest('hex');
}

function requireDirectory(directoryPath, label) {
	const status = entryAt(directoryPath);
	if (!isDirectory(status)) {
		throw new Error(`${label} must be a real directory: ${directoryPath}`);
	}
	return status;
}

function directoryIdentity(status) {
	return `${status.dev}:${status.ino}`;
}

function utf8Filename(name, parentPath) {
	const decoded = name.toString('utf8');
	if (!Buffer.from(decoded, 'utf8').equals(name)) {
		throw new Error(`model artifact contains a non-UTF-8 filename under ${parentPath}`);
	}
	return decoded;
}

function directoryArtifactManifest(directoryPath) {
	const visitedDirectories = new Set();
	const records = [];

	const visit = (currentPath, relativePath) => {
		const initial = requireDirectory(currentPath, 'model artifact directory');
		const identity = directoryIdentity(initial);
		if (visitedDirectories.has(identity)) {
			throw new Error(`model artifact directory is aliased: ${currentPath}`);
		}
		visitedDirectories.add(identity);

		let descriptor;
		try {
			descriptor = fs.openSync(
				currentPath,
				fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
			);
			const opened = fs.fstatSync(descriptor, { bigint: true });
			if (!isDirectory(opened) || !sameFileSnapshot(initial, opened)) {
				throw new Error(`model artifact directory changed while it was opened: ${currentPath}`);
			}

			records.push({ kind: 'directory', path: relativePath });
			const entries = fs
				.readdirSync(currentPath, { encoding: 'buffer', withFileTypes: true })
				.sort((left, right) => Buffer.compare(left.name, right.name));
			for (const entry of entries) {
				const filename = utf8Filename(entry.name, currentPath);
				const childPath = path.join(currentPath, filename);
				const childRelativePath =
					relativePath.length === 0 ? filename : `${relativePath}/${filename}`;
				const status = entryAt(childPath);
				if (status?.isSymbolicLink()) {
					throw new Error(`model artifact entries cannot be symbolic links: ${childPath}`);
				}
				if (status?.isDirectory()) {
					visit(childPath, childRelativePath);
				} else if (status?.isFile()) {
					records.push({
						kind: 'file',
						path: childRelativePath,
						sha256: sha256File(childPath),
					});
				} else {
					throw new Error(
						`model artifact entries must be regular files or directories: ${childPath}`,
					);
				}
			}

			const finalDescriptor = fs.fstatSync(descriptor, { bigint: true });
			const finalPath = entryAt(currentPath);
			if (
				!isDirectory(finalDescriptor) ||
				!isDirectory(finalPath) ||
				!sameFileSnapshot(opened, finalDescriptor) ||
				!sameFileSnapshot(finalDescriptor, finalPath)
			) {
				throw new Error(
					`model artifact directory changed while it was being hashed: ${currentPath}`,
				);
			}
		} finally {
			if (descriptor !== undefined) fs.closeSync(descriptor);
		}
	};

	visit(directoryPath, '');
	return records;
}

function copyDirectoryArtifactSnapshot(
	sourceDirectory,
	destinationDirectory,
	copyFileSnapshotImpl,
) {
	const visitedDirectories = new Set();

	const visit = (sourcePath, destinationPath) => {
		const initial = requireDirectory(sourcePath, 'model artifact directory');
		const identity = directoryIdentity(initial);
		if (visitedDirectories.has(identity)) {
			throw new Error(`model artifact directory is aliased: ${sourcePath}`);
		}
		visitedDirectories.add(identity);

		let descriptor;
		try {
			descriptor = fs.openSync(
				sourcePath,
				fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
			);
			const opened = fs.fstatSync(descriptor, { bigint: true });
			if (!isDirectory(opened) || !sameFileSnapshot(initial, opened)) {
				throw new Error(`model artifact directory changed while it was opened: ${sourcePath}`);
			}
			fs.mkdirSync(destinationPath, { mode: 0o700 });
			const entries = fs
				.readdirSync(sourcePath, { encoding: 'buffer', withFileTypes: true })
				.sort((left, right) => Buffer.compare(left.name, right.name));
			for (const entry of entries) {
				const filename = utf8Filename(entry.name, sourcePath);
				const sourceChild = path.join(sourcePath, filename);
				const destinationChild = path.join(destinationPath, filename);
				const status = entryAt(sourceChild);
				if (status?.isSymbolicLink()) {
					throw new Error(`model artifact entries cannot be symbolic links: ${sourceChild}`);
				}
				if (status?.isDirectory()) {
					visit(sourceChild, destinationChild);
				} else if (status?.isFile()) {
					copyFileSnapshotImpl(sourceChild, destinationChild, {
						label: 'model artifact snapshot file',
						mode: 0o600,
					});
				} else {
					throw new Error(
						`model artifact entries must be regular files or directories: ${sourceChild}`,
					);
				}
			}
			const finalDescriptor = fs.fstatSync(descriptor, { bigint: true });
			const finalPath = entryAt(sourcePath);
			if (
				!isDirectory(finalDescriptor) ||
				!isDirectory(finalPath) ||
				!sameFileSnapshot(opened, finalDescriptor) ||
				!sameFileSnapshot(finalDescriptor, finalPath)
			) {
				throw new Error(
					`model artifact directory changed while it was being snapshotted: ${sourcePath}`,
				);
			}
		} finally {
			if (descriptor !== undefined) fs.closeSync(descriptor);
		}
	};

	visit(sourceDirectory, destinationDirectory);
}

/**
 * Mirror whisper.cpp's `whisper_get_coreml_path_encoder` exactly:
 * remove the final extension, then remove a trailing five-character `-qX_Y`
 * quantization suffix before appending `-encoder.mlmodelc`.
 */
export function coreMlEncoderBundlePath(ggmlModelPath) {
	let basePath = ggmlModelPath;
	const extension = basePath.lastIndexOf('.');
	if (extension !== -1) basePath = basePath.slice(0, extension);
	const suffixStart = basePath.lastIndexOf('-');
	if (suffixStart !== -1) {
		const suffix = basePath.slice(suffixStart);
		if (suffix.length === 5 && suffix[1] === 'q' && suffix[3] === '_') {
			basePath = basePath.slice(0, suffixStart);
		}
	}
	return `${basePath}-encoder.mlmodelc`;
}

function whisperArtifactSha256(modelPath, reportedBackend) {
	const ggmlDigest = sha256File(modelPath);
	if (reportedBackend !== 'coreml-metal') return ggmlDigest;

	const parentPath = path.dirname(modelPath);
	const initialParent = requireDirectory(parentPath, 'Whisper model directory');
	const bundlePath = coreMlEncoderBundlePath(modelPath);
	const bundleRecords = directoryArtifactManifest(bundlePath);
	const finalParent = entryAt(parentPath);
	if (!isDirectory(finalParent) || !sameFileSnapshot(initialParent, finalParent)) {
		throw new Error('Whisper/Core ML model artifact set changed while it was being hashed');
	}
	return createHash('sha256')
		.update(
			JSON.stringify({
				schema_version: 1,
				ggml: {
					filename: path.basename(modelPath),
					sha256: ggmlDigest,
				},
				coreml: {
					directory: path.basename(bundlePath),
					entries: bundleRecords,
				},
			}),
		)
		.digest('hex');
}

function parakeetArtifactFilenames(modelDirectory) {
	const int8 = entryAt(path.join(modelDirectory, 'encoder-model.int8.onnx')) !== undefined;
	const filenames = int8
		? ['encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx', 'nemo128.onnx', 'vocab.txt']
		: ['encoder-model.onnx', 'decoder_joint-model.onnx', 'nemo128.onnx', 'vocab.txt'];
	if (!int8 && entryAt(path.join(modelDirectory, 'encoder-model.onnx.data')) !== undefined) {
		filenames.splice(1, 0, 'encoder-model.onnx.data');
	}
	return filenames;
}

/**
 * Fingerprint the bytes actually consumed by an evaluation model.
 *
 * Whisper normally consumes one GGML file. The `coreml-metal` backend also
 * consumes the exact compiled encoder bundle derived by whisper.cpp, so that
 * backend's fingerprint binds both the GGML file and the complete bundle tree.
 * Parakeet is an ONNX artifact set, so its fingerprint is the SHA-256 of a
 * stable filename + per-file-SHA-256 manifest.
 */
export function modelArtifactSha256(provider, model, modelsDirectory, reportedBackend) {
	if (typeof reportedBackend !== 'string' || reportedBackend.length === 0) {
		throw new Error('reported benchmark backend is required for model artifact hashing');
	}
	const validatedModel = validateBenchmarkModelName(model);
	if (provider === 'whisper') {
		return whisperArtifactSha256(
			path.join(modelsDirectory, `ggml-${validatedModel}.bin`),
			reportedBackend,
		);
	}
	if (provider !== 'parakeet') throw new Error(`unsupported model provider: ${provider}`);

	const modelDirectory = path.join(modelsDirectory, 'parakeet', validatedModel);
	const filenames = parakeetArtifactFilenames(modelDirectory);
	const manifest = filenames
		.map((filename) => `${filename}\0${sha256File(path.join(modelDirectory, filename))}`)
		.join('\n');
	if (JSON.stringify(parakeetArtifactFilenames(modelDirectory)) !== JSON.stringify(filenames)) {
		throw new Error('Parakeet model artifact set changed while it was being hashed');
	}
	return createHash('sha256').update(manifest).digest('hex');
}

export function stageModelArtifactSnapshot(
	provider,
	model,
	modelsDirectory,
	reportedBackend,
	snapshotRoot,
	expectedSha256,
	{ copyFileSnapshotImpl = copyAttestedFileSnapshot } = {},
) {
	if (!SHA256_PATTERN.test(expectedSha256)) {
		throw new Error('expected model artifact SHA-256 is invalid');
	}
	const validatedModel = validateBenchmarkModelName(model);
	if (entryAt(snapshotRoot) !== undefined) {
		throw new Error('model artifact snapshot destination already exists');
	}
	const snapshotModelsDirectory = path.join(snapshotRoot, 'models');
	try {
		fs.mkdirSync(snapshotRoot, { mode: 0o700 });
		fs.mkdirSync(snapshotModelsDirectory, { mode: 0o700 });
		if (provider === 'whisper') {
			const filename = `ggml-${validatedModel}.bin`;
			copyFileSnapshotImpl(
				path.join(modelsDirectory, filename),
				path.join(snapshotModelsDirectory, filename),
				{
					label: 'Whisper model artifact snapshot',
					mode: 0o600,
				},
			);
			if (reportedBackend === 'coreml-metal') {
				copyDirectoryArtifactSnapshot(
					coreMlEncoderBundlePath(path.join(modelsDirectory, filename)),
					coreMlEncoderBundlePath(path.join(snapshotModelsDirectory, filename)),
					copyFileSnapshotImpl,
				);
			}
		} else if (provider === 'parakeet') {
			const sourceDirectory = path.join(modelsDirectory, 'parakeet', validatedModel);
			const destinationDirectory = path.join(snapshotModelsDirectory, 'parakeet', validatedModel);
			fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
			for (const filename of parakeetArtifactFilenames(sourceDirectory)) {
				copyFileSnapshotImpl(
					path.join(sourceDirectory, filename),
					path.join(destinationDirectory, filename),
					{
						label: 'Parakeet model artifact snapshot',
						mode: 0o600,
					},
				);
			}
		} else {
			throw new Error(`unsupported model provider: ${provider}`);
		}

		const snapshotSha256 = modelArtifactSha256(
			provider,
			validatedModel,
			snapshotModelsDirectory,
			reportedBackend,
		);
		if (snapshotSha256 !== expectedSha256) {
			throw new Error('model artifact snapshot does not match the expected SHA-256');
		}
		return {
			modelsDirectory: snapshotModelsDirectory,
			sha256: snapshotSha256,
		};
	} catch (error) {
		fs.rmSync(snapshotRoot, { recursive: true, force: true });
		throw error;
	}
}

export function resolveModelsDirectory(modelsDirectory, repositoryRoot) {
	return path.resolve(repositoryRoot, modelsDirectory ?? 'models');
}
