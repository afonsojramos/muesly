import {
	requiresExplicitAccelerator,
	supportedBackends,
} from './backend.ts';

const FLAG_FIELDS = new Map([
	['--max-wer', 'maxWerPct'],
	['--max-hallucinated-words', 'maxHallucinatedWords'],
	['--provider', 'provider'],
	['--model', 'model'],
	['--models-dir', 'modelsDir'],
	['--manifest', 'manifestPath'],
	['--backend', 'backend'],
	['--accelerator', 'accelerator'],
	['--output', 'outputPath'],
	['--fixture', 'onlyFixture'],
]);

function requiredValue(args, index, option) {
	const value = args[index + 1];
	if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function nonNegativeNumber(value, option) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${option} requires a non-negative number`);
	}
	return parsed;
}

export function parseRealRunArgs(
	args,
	{
		defaultManifest,
		platform = process.platform,
		architecture = process.arch,
	} = {},
) {
	if (!defaultManifest) throw new Error('defaultManifest is required');
	const parsed = {};
	const seen = new Set();
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		const field = FLAG_FIELDS.get(option);
		if (!field) throw new Error(`unknown option: ${option}`);
		if (seen.has(option)) throw new Error(`${option} may only be provided once`);
		seen.add(option);
		parsed[field] = requiredValue(args, index, option);
		index += 1;
	}

	const provider = parsed.provider ?? 'whisper';
	if (!['whisper', 'parakeet'].includes(provider)) {
		throw new Error('--provider requires whisper or parakeet');
	}
	const backend = parsed.backend ?? 'cpu';
	if (!supportedBackends.includes(backend)) {
		throw new Error(`--backend requires one of: ${supportedBackends.join(', ')}`);
	}
	if (provider === 'parakeet' && backend !== 'cpu') {
		throw new Error("Parakeet currently supports only --backend cpu (reported as 'onnx-cpu')");
	}
	const accelerator = parsed.accelerator ?? null;
	if (accelerator && /[;\r\n]/.test(accelerator)) {
		throw new Error('--accelerator cannot contain semicolons or line breaks');
	}
	if (requiresExplicitAccelerator(provider, backend, platform, architecture) && !accelerator) {
		throw new Error(
			`--backend ${backend} requires --accelerator with a stable accelerator model or device identifier`,
		);
	}
	const maxWerPct =
		parsed.maxWerPct === undefined
			? 10
			: nonNegativeNumber(parsed.maxWerPct, '--max-wer');
	const maxHallucinatedWords =
		parsed.maxHallucinatedWords === undefined
			? 2
			: nonNegativeNumber(
					parsed.maxHallucinatedWords,
					'--max-hallucinated-words',
				);
	if (!Number.isInteger(maxHallucinatedWords)) {
		throw new Error('--max-hallucinated-words requires a non-negative integer');
	}

	return {
		maxWerPct,
		maxHallucinatedWords,
		provider,
		backend,
		accelerator,
		model:
			parsed.model ??
			(provider === 'parakeet' ? 'parakeet-tdt-0.6b-v3-int8' : 'tiny'),
		modelsDir: parsed.modelsDir ?? null,
		onlyFixture: parsed.onlyFixture ?? null,
		manifestPath: parsed.manifestPath ?? defaultManifest,
		outputPath: parsed.outputPath ?? null,
	};
}
