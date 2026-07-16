import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CORPUS_SCHEMA_VERSION = 1;

const PROVENANCE_BASES = new Set(['participant-consent', 'public-domain', 'synthetic']);
const REDISTRIBUTION_SCOPES = new Set(['repository', 'local-only']);
const FORBIDDEN_IDENTITY_FIELDS = new Set(['name', 'email', 'contact', 'participant_name']);

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

function validateProvenance(sample, errors) {
	const prefix = `sample '${sample.id ?? '?'}'.provenance`;
	const provenance = sample.provenance;
	if (!isObject(provenance)) {
		errors.push(`${prefix} must be an object`);
		return;
	}

	for (const field of FORBIDDEN_IDENTITY_FIELDS) {
		if (field in provenance) {
			errors.push(`${prefix}.${field} must not contain participant identity; keep it out of the repository`);
		}
	}

	if (!PROVENANCE_BASES.has(provenance.basis)) {
		errors.push(`${prefix}.basis must be participant-consent, public-domain, or synthetic`);
	}
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
		if (!Array.isArray(provenance.consented_uses) || !provenance.consented_uses.includes('asr-benchmarking')) {
			errors.push(`${prefix}.consented_uses must include asr-benchmarking`);
		}
		requiredString(provenance.consent_date, `${prefix}.consent_date`, errors);
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
	const { manifestPath = path.resolve('corpus-manifest.json'), checkFiles = true } = options;
	const errors = [];
	if (!isObject(document)) return ['manifest must be a JSON object'];
	if (document.schema_version !== CORPUS_SCHEMA_VERSION) {
		errors.push(`schema_version must be ${CORPUS_SCHEMA_VERSION}`);
	}
	requiredString(document.corpus_id, 'corpus_id', errors);
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
		if (requiredString(sample.id, `${prefix}.id`, errors)) {
			if (!/^[a-z0-9][a-z0-9-]*$/.test(sample.id)) {
				errors.push(`${prefix}.id must be a lowercase slug`);
			}
			if (ids.has(sample.id)) errors.push(`${prefix}.id is duplicated`);
			ids.add(sample.id);
		}
		if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(sample.language ?? '')) {
			errors.push(`${prefix}.language must be a BCP-47-style language tag`);
		}
		requiredString(sample.scenario, `${prefix}.scenario`, errors);
		if (!/^[a-z0-9][a-z0-9-]*$/.test(sample.noise_condition ?? '')) {
			errors.push(`${prefix}.noise_condition must be a lowercase slug`);
		}
		if (!Number.isInteger(sample.speakers) || sample.speakers < 0) {
			errors.push(`${prefix}.speakers must be a non-negative integer`);
		}
		if (typeof sample.duration_seconds !== 'number' || sample.duration_seconds <= 0) {
			errors.push(`${prefix}.duration_seconds must be positive`);
		}
		validateFile(sample, 'audio_path', 'audio_sha256', manifestPath, checkFiles, errors);
		validateFile(sample, 'reference_path', 'reference_sha256', manifestPath, checkFiles, errors);
		validateProvenance(sample, errors);
	}
	return errors;
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
