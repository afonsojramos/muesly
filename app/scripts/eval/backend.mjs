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
