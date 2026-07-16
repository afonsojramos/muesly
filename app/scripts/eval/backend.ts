export const supportedBackends = [
	'cpu',
	'metal',
	'cuda',
	'vulkan',
	'openblas',
	'hipblas',
];

const whisperGpuBackends = new Set(['metal', 'cuda', 'vulkan', 'hipblas']);

export function requiresWhisperGpu(provider, backend) {
	return provider === 'whisper' && whisperGpuBackends.has(backend);
}

export function forcesWhisperCpu(provider, backend) {
	return provider === 'whisper' && (backend === 'cpu' || backend === 'openblas');
}

export function requiresExplicitAccelerator(
	provider,
	backend,
	platform = process.platform,
	architecture = process.arch,
) {
	if (!requiresWhisperGpu(provider, backend)) return false;
	return !(backend === 'metal' && platform === 'darwin' && architecture === 'arm64');
}
