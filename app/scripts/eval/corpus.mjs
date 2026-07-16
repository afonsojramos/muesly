import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CORPUS_SCHEMA_VERSION = 2;

const PROVENANCE_BASES = new Set(['participant-consent', 'public-domain', 'synthetic']);
const REDISTRIBUTION_SCOPES = new Set(['repository', 'local-only']);
const CONSENTED_USES = new Set(['asr-benchmarking']);
const MANIFEST_FIELDS = new Set(['schema_version', 'corpus_id', 'description', 'distribution', 'samples']);
const SAMPLE_FIELDS = new Set([
	'id',
	'session_id',
	'audio_path',
	'audio_sha256',
	'reference_path',
	'reference_sha256',
	'language',
	'whisper_language',
	'scenario',
	'noise_condition',
	'speakers',
	'duration_seconds',
	'provenance',
]);
const PROVENANCE_FIELDS = {
	'participant-consent': new Set([
		'basis',
		'redistribution',
		'consent_record_id',
		'consent_date',
		'consented_uses',
	]),
	'public-domain': new Set(['basis', 'redistribution', 'source_url', 'license']),
	synthetic: new Set(['basis', 'redistribution', 'generation_method']),
};

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(filePath) {
	return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveSamplePath(manifestPath, value) {
	return path.resolve(path.dirname(manifestPath), value);
}

function requiredString(value, field, errors) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		errors.push(`${field} must be a non-empty string`);
		return false;
	}
	return true;
}

function rejectUnknownFields(value, allowed, prefix, errors) {
	for (const field of Object.keys(value)) {
		if (!allowed.has(field)) errors.push(`${prefix}.${field} is not an allowed field`);
	}
}

function isIsoDate(value) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateProvenance(sample, errors) {
	const prefix = `sample '${sample.id ?? '?'}'.provenance`;
	const provenance = sample.provenance;
	if (!isObject(provenance)) {
		errors.push(`${prefix} must be an object`);
		return;
	}

	if (!PROVENANCE_BASES.has(provenance.basis)) {
		errors.push(`${prefix}.basis must be participant-consent, public-domain, or synthetic`);
		return;
	}
	rejectUnknownFields(provenance, PROVENANCE_FIELDS[provenance.basis], prefix, errors);
	if (!REDISTRIBUTION_SCOPES.has(provenance.redistribution)) {
		errors.push(`${prefix}.redistribution must be repository or local-only`);
	}

	if (provenance.basis === 'participant-consent') {
		if (!requiredString(provenance.consent_record_id, `${prefix}.consent_record_id`, errors)) {
			return;
		}
		if (!/^consent-[a-z0-9][a-z0-9-]*$/.test(provenance.consent_record_id)) {
			errors.push(`${prefix}.consent_record_id must be an opaque consent-* identifier`);
		}
		if (
			!Array.isArray(provenance.consented_uses) ||
			provenance.consented_uses.some(
				(use) => typeof use !== 'string' || !CONSENTED_USES.has(use),
			)
		) {
			errors.push(`${prefix}.consented_uses may only contain known string values`);
		} else if (!provenance.consented_uses.includes('asr-benchmarking')) {
			errors.push(`${prefix}.consented_uses must include asr-benchmarking`);
		}
		if (!isIsoDate(provenance.consent_date)) {
			errors.push(`${prefix}.consent_date must be a valid YYYY-MM-DD date`);
		}
		if (provenance.redistribution !== 'local-only') {
			errors.push(`${prefix}.redistribution must be local-only for participant recordings`);
		}
	} else if (provenance.basis === 'public-domain') {
		requiredString(provenance.source_url, `${prefix}.source_url`, errors);
		requiredString(provenance.license, `${prefix}.license`, errors);
	} else if (provenance.basis === 'synthetic') {
		requiredString(provenance.generation_method, `${prefix}.generation_method`, errors);
	}

	if (sample.scenario === 'meeting' && provenance.basis !== 'participant-consent') {
		errors.push(`${prefix}.basis must be participant-consent for meeting recordings`);
	}
}

function validateFile(sample, field, hashField, manifestPath, checkFiles, errors) {
	const prefix = `sample '${sample.id ?? '?'}'`;
	if (!requiredString(sample[field], `${prefix}.${field}`, errors)) return;
	if (!/^[a-f0-9]{64}$/.test(sample[hashField] ?? '')) {
		errors.push(`${prefix}.${hashField} must be a lowercase SHA-256 digest`);
	}
	if (!checkFiles) return;

	const filePath = resolveSamplePath(manifestPath, sample[field]);
	if (!fs.existsSync(filePath)) {
		errors.push(`${prefix}.${field} does not exist: ${filePath}`);
		return;
	}
	if (fs.statSync(filePath).isDirectory()) {
		errors.push(`${prefix}.${field} must reference a file`);
		return;
	}
	if (/^[a-f0-9]{64}$/.test(sample[hashField] ?? '') && sha256(filePath) !== sample[hashField]) {
		errors.push(`${prefix}.${hashField} does not match ${sample[field]}`);
	}
}

export function validateCorpusDocument(document, options = {}) {
	const {
		manifestPath = path.resolve('corpus-manifest.json'),
		checkFiles = true,
		requiredAudioFiles = [],
	} = options;
	const errors = [];
	if (!isObject(document)) return ['manifest must be a JSON object'];
	rejectUnknownFields(document, MANIFEST_FIELDS, 'manifest', errors);
	if (document.schema_version !== CORPUS_SCHEMA_VERSION) {
		errors.push(`schema_version must be ${CORPUS_SCHEMA_VERSION}`);
	}
	requiredString(document.corpus_id, 'corpus_id', errors);
	if (!['repository', 'local'].includes(document.distribution)) {
		errors.push('distribution must be repository or local');
	}
	if (!Array.isArray(document.samples) || document.samples.length === 0) {
		errors.push('samples must be a non-empty array');
		return errors;
	}

	const ids = new Set();
	for (const sample of document.samples) {
		if (!isObject(sample)) {
			errors.push('each sample must be an object');
			continue;
		}
		const prefix = `sample '${sample.id ?? '?'}'`;
		rejectUnknownFields(sample, SAMPLE_FIELDS, prefix, errors);
		if (requiredString(sample.id, `${prefix}.id`, errors)) {
			if (!/^[a-z0-9][a-z0-9-]*$/.test(sample.id)) {
				errors.push(`${prefix}.id must be a lowercase slug`);
			}
			if (ids.has(sample.id)) errors.push(`${prefix}.id is duplicated`);
			ids.add(sample.id);
		}
		if (sample.session_id !== undefined && !/^session-[a-z0-9][a-z0-9-]*$/.test(sample.session_id)) {
			errors.push(`${prefix}.session_id must be an opaque session-* identifier`);
		}
		if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(sample.language ?? '')) {
			errors.push(`${prefix}.language must be a BCP-47-style language tag`);
		}
		if (sample.whisper_language !== undefined && !/^[a-z]{2,3}$/.test(sample.whisper_language)) {
			errors.push(`${prefix}.whisper_language must be a lowercase Whisper language code`);
		}
		requiredString(sample.scenario, `${prefix}.scenario`, errors);
		if (!/^[a-z0-9][a-z0-9-]*$/.test(sample.noise_condition ?? '')) {
			errors.push(`${prefix}.noise_condition must be a lowercase slug`);
		}
		if (!Number.isInteger(sample.speakers) || sample.speakers < 0) {
			errors.push(`${prefix}.speakers must be a non-negative integer`);
		}
		if (sample.scenario === 'meeting') {
			if (!/^session-[a-z0-9][a-z0-9-]*$/.test(sample.session_id ?? '')) {
				errors.push(`${prefix}.session_id is required for meeting recordings`);
			}
			if (!Number.isInteger(sample.speakers) || sample.speakers < 2) {
				errors.push(`${prefix}.speakers must be at least 2 for meeting recordings`);
			}
		}
		if (typeof sample.duration_seconds !== 'number' || sample.duration_seconds <= 0) {
			errors.push(`${prefix}.duration_seconds must be positive`);
		}
		validateFile(sample, 'audio_path', 'audio_sha256', manifestPath, checkFiles, errors);
		validateFile(sample, 'reference_path', 'reference_sha256', manifestPath, checkFiles, errors);
		validateProvenance(sample, errors);
		if (document.distribution === 'repository' && sample.provenance?.redistribution === 'local-only') {
			errors.push(`${prefix}.provenance.redistribution cannot be local-only in a repository manifest`);
		}
	}

	const declaredAudio = new Set(
		document.samples
			.filter(
				(sample) =>
					isObject(sample) &&
					typeof sample.audio_path === 'string' &&
					sample.audio_path.trim().length > 0,
			)
			.map((sample) => resolveSamplePath(manifestPath, sample.audio_path)),
	);
	for (const requiredAudio of requiredAudioFiles.map((file) => path.resolve(file))) {
		if (!declaredAudio.has(requiredAudio)) {
			errors.push(`audio fixture is missing from the manifest: ${requiredAudio}`);
		}
	}
	return errors;
}

export function whisperLanguageForSample(sample) {
	if (sample.language === 'und') return null;
	return sample.whisper_language ?? sample.language.split('-')[0].toLowerCase();
}

export function loadCorpus(manifestPath, options = {}) {
	const absolutePath = path.resolve(manifestPath);
	let document;
	try {
		document = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to read corpus manifest ${absolutePath}: ${error.message}`);
	}
	const errors = validateCorpusDocument(document, { manifestPath: absolutePath, ...options });
	if (errors.length > 0) {
		throw new Error(`invalid corpus manifest:\n- ${errors.join('\n- ')}`);
	}
	return {
		...document,
		manifest_path: absolutePath,
		samples: document.samples.map((sample) => ({
			...sample,
			audio_file: resolveSamplePath(absolutePath, sample.audio_path),
			reference_file: resolveSamplePath(absolutePath, sample.reference_path),
		})),
	};
}
