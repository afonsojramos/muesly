const VALUE_OPTIONS = new Set([
	'--manifest',
	'--targets',
	'--models-dir',
	'--max-wer',
	'--max-hallucinated-words',
	'--variant',
	'--accelerator',
]);

const BOOLEAN_OPTIONS = new Set(['--run', '--require-complete']);
const REPEATABLE_OPTIONS = new Set(['--variant', '--accelerator']);
const VARIANT_PART = /^[a-z0-9][a-z0-9._-]*$/;
const BACKEND = /^[a-z0-9][a-z0-9-]*$/;

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

function parseVariant(value) {
	const parts = value.split('/');
	if (parts.length !== 3 || parts.some((part) => !VARIANT_PART.test(part))) {
		throw new Error('--variant requires provider/model/backend using lowercase slug values');
	}
	return value;
}

function parseAccelerator(value) {
	const separator = value.indexOf('=');
	const backend = value.slice(0, separator);
	const accelerator = value.slice(separator + 1).trim();
	if (
		separator <= 0 ||
		!BACKEND.test(backend) ||
		accelerator.length === 0 ||
		/[;\r\n]/.test(accelerator)
	) {
		throw new Error(
			'--accelerator requires backend=stable-device-id without semicolons or line breaks',
		);
	}
	return { backend, accelerator };
}

export function parseCorpusBenchmarkArgs(args, { defaultManifest, defaultTargets } = {}) {
	if (!defaultManifest) throw new Error('defaultManifest is required');
	if (!defaultTargets) throw new Error('defaultTargets is required');

	const seen = new Set();
	const selectedVariants = [];
	const selectedVariantSet = new Set();
	const accelerators = {};
	let manifestPath = defaultManifest;
	let targetsPath = defaultTargets;
	let modelsDir = null;
	let maxWerPct = 10;
	let maxHallucinatedWords = 2;
	let run = false;
	let requireComplete = false;

	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		if (!VALUE_OPTIONS.has(option) && !BOOLEAN_OPTIONS.has(option)) {
			throw new Error(`unknown option: ${option}`);
		}
		if (!REPEATABLE_OPTIONS.has(option) && seen.has(option)) {
			throw new Error(`${option} may only be provided once`);
		}
		seen.add(option);

		if (BOOLEAN_OPTIONS.has(option)) {
			if (option === '--run') run = true;
			else requireComplete = true;
			continue;
		}

		const value = requiredValue(args, index, option);
		index += 1;
		switch (option) {
			case '--manifest':
				manifestPath = value;
				break;
			case '--targets':
				targetsPath = value;
				break;
			case '--models-dir':
				modelsDir = value;
				break;
			case '--max-wer':
				maxWerPct = nonNegativeNumber(value, option);
				break;
			case '--max-hallucinated-words':
				maxHallucinatedWords = nonNegativeNumber(value, option);
				if (!Number.isInteger(maxHallucinatedWords)) {
					throw new Error('--max-hallucinated-words requires a non-negative integer');
				}
				break;
			case '--variant': {
				const variant = parseVariant(value);
				if (selectedVariantSet.has(variant)) {
					throw new Error(`--variant duplicates '${variant}'`);
				}
				selectedVariantSet.add(variant);
				selectedVariants.push(variant);
				break;
			}
			case '--accelerator': {
				const parsed = parseAccelerator(value);
				if (Object.hasOwn(accelerators, parsed.backend)) {
					throw new Error(`--accelerator duplicates backend '${parsed.backend}'`);
				}
				accelerators[parsed.backend] = parsed.accelerator;
				break;
			}
		}
	}

	return {
		manifestPath,
		targetsPath,
		modelsDir,
		maxWerPct,
		maxHallucinatedWords,
		selectedVariants,
		accelerators,
		run,
		requireComplete,
	};
}
