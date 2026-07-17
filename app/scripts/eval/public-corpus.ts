import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
	CORPUS_SCHEMA_VERSION,
	fileSha256,
	PUBLIC_PREPARATION_PROTOCOL_ID,
	REFERENCE_PROTOCOL_ID,
	validateCorpusDocument,
} from './corpus.ts';
import {
	acquirePublicCorpusLock,
	assertPublicCorpusLockOwned,
	releasePublicCorpusLock,
} from './public-corpus-lock.ts';

export const PUBLIC_CATALOG_SCHEMA_VERSION = 2;
export const PUBLIC_SELECTION_SCHEMA_VERSION = 2;
export const PUBLIC_PREPARED_SCHEMA_VERSION = 3;
export const PUBLIC_REVIEW_SCHEMA_VERSION = 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ARTIFACT_KINDS = new Set([
	'alignment-hypothesis',
	'audio',
	'audio-archive',
	'index',
	'reference',
	'reference-archive',
]);
const ARCHIVE_FORMATS = new Set(['tar.gz', 'zip']);
const CONDITION_IDS = new Set([
	'clean-read',
	'synthetic-office',
	'synthetic-remote-call',
	'synthetic-overlap',
]);

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, field, errors) {
	if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
		errors.push(`${field} must be a non-empty trimmed string`);
		return false;
	}
	return true;
}

function rejectUnknownFields(value, allowed, prefix, errors) {
	for (const field of Object.keys(value)) {
		if (!allowed.has(field)) errors.push(`${prefix}.${field} is not an allowed field`);
	}
}

function isSafeRelativePath(value) {
	if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
	const normalized = value.replaceAll('\\', '/');
	if (
		path.posix.isAbsolute(normalized) ||
		/^[A-Za-z]:/.test(normalized) ||
		normalized.startsWith('//')
	) {
		return false;
	}
	const parts = normalized.split('/');
	return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function readJsonFile(filePath, label = 'JSON file') {
	const entry = fs.lstatSync(filePath, { throwIfNoEntry: false });
	if (!entry?.isFile() || entry.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file: ${filePath}`);
	}
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to parse ${label} ${filePath}: ${error.message}`);
	}
}

export function validateSourceCatalog(document, options = {}) {
	const errors = [];
	if (!isObject(document)) return ['source catalog must be an object'];
	rejectUnknownFields(
		document,
		new Set(['schema_version', 'catalog_id', 'description', 'artifacts', 'sources']),
		'catalog',
		errors,
	);
	if (document.schema_version !== PUBLIC_CATALOG_SCHEMA_VERSION) {
		errors.push(`catalog.schema_version must be ${PUBLIC_CATALOG_SCHEMA_VERSION}`);
	}
	if (
		!requiredString(document.catalog_id, 'catalog.catalog_id', errors) ||
		!SLUG_PATTERN.test(document.catalog_id)
	) {
		errors.push('catalog.catalog_id must be a lowercase slug');
	}
	requiredString(document.description, 'catalog.description', errors);

	const artifactIds = new Set();
	const cachePaths = new Set();
	if (!Array.isArray(document.artifacts) || document.artifacts.length === 0) {
		errors.push('catalog.artifacts must be a non-empty array');
	} else {
		for (const [index, artifact] of document.artifacts.entries()) {
			const prefix = `catalog.artifacts[${index}]`;
			if (!isObject(artifact)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			rejectUnknownFields(
				artifact,
				new Set([
					'id',
					'kind',
					'url',
					'cache_path',
					'sha256',
					'size_bytes',
					'archive_format',
					'revision',
				]),
				prefix,
				errors,
			);
			if (!requiredString(artifact.id, `${prefix}.id`, errors) || !SLUG_PATTERN.test(artifact.id)) {
				errors.push(`${prefix}.id must be a lowercase slug`);
			} else if (artifactIds.has(artifact.id)) {
				errors.push(`${prefix}.id duplicates '${artifact.id}'`);
			}
			artifactIds.add(artifact.id);
			if (!ARTIFACT_KINDS.has(artifact.kind)) {
				errors.push(`${prefix}.kind is not supported`);
			}
			if (artifact.kind === 'alignment-hypothesis') {
				requiredString(artifact.revision, `${prefix}.revision`, errors);
			} else if (artifact.revision !== undefined) {
				requiredString(artifact.revision, `${prefix}.revision`, errors);
			}
			if (requiredString(artifact.url, `${prefix}.url`, errors)) {
				let url;
				try {
					url = new URL(artifact.url);
				} catch {
					errors.push(`${prefix}.url must be an absolute URL`);
				}
				if (
					url &&
					url.protocol !== 'https:' &&
					!(options.allowInsecureUrls && url.protocol === 'http:')
				) {
					errors.push(`${prefix}.url must use HTTPS`);
				}
			}
			if (!isSafeRelativePath(artifact.cache_path)) {
				errors.push(`${prefix}.cache_path must be a safe relative path`);
			} else if (cachePaths.has(artifact.cache_path)) {
				errors.push(`${prefix}.cache_path duplicates '${artifact.cache_path}'`);
			}
			cachePaths.add(artifact.cache_path);
			if (!SHA256_PATTERN.test(artifact.sha256 ?? '')) {
				errors.push(`${prefix}.sha256 must be a lowercase SHA-256 digest`);
			}
			if (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes <= 0) {
				errors.push(`${prefix}.size_bytes must be a positive safe integer`);
			}
			const archiveKind =
				artifact.kind === 'audio-archive' || artifact.kind === 'reference-archive';
			if (archiveKind && !ARCHIVE_FORMATS.has(artifact.archive_format)) {
				errors.push(`${prefix}.archive_format must be tar.gz or zip`);
			}
			if (!archiveKind && artifact.archive_format !== undefined) {
				errors.push(`${prefix}.archive_format is only valid for archive artifacts`);
			}
		}
	}

	const sourceIds = new Set();
	const usedArtifacts = new Set();
	if (!Array.isArray(document.sources) || document.sources.length === 0) {
		errors.push('catalog.sources must be a non-empty array');
	} else {
		for (const [index, source] of document.sources.entries()) {
			const prefix = `catalog.sources[${index}]`;
			if (!isObject(source)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			rejectUnknownFields(
				source,
				new Set([
					'id',
					'dataset',
					'revision',
					'homepage',
					'license_id',
					'license_url',
					'attribution',
					'redistribution',
					'artifact_ids',
				]),
				prefix,
				errors,
			);
			if (!requiredString(source.id, `${prefix}.id`, errors) || !SLUG_PATTERN.test(source.id)) {
				errors.push(`${prefix}.id must be a lowercase slug`);
			} else if (sourceIds.has(source.id)) {
				errors.push(`${prefix}.id duplicates '${source.id}'`);
			}
			sourceIds.add(source.id);
			for (const field of [
				'dataset',
				'revision',
				'homepage',
				'license_id',
				'license_url',
				'attribution',
			]) {
				requiredString(source[field], `${prefix}.${field}`, errors);
			}
			for (const field of ['homepage', 'license_url']) {
				try {
					if (new URL(source[field]).protocol !== 'https:') {
						errors.push(`${prefix}.${field} must use HTTPS`);
					}
				} catch {
					errors.push(`${prefix}.${field} must be an absolute URL`);
				}
			}
			if (source.redistribution !== 'local-only') {
				errors.push(`${prefix}.redistribution must be local-only`);
			}
			if (!Array.isArray(source.artifact_ids) || source.artifact_ids.length === 0) {
				errors.push(`${prefix}.artifact_ids must be a non-empty array`);
			} else {
				const localIds = new Set();
				for (const artifactId of source.artifact_ids) {
					if (!artifactIds.has(artifactId)) {
						errors.push(`${prefix}.artifact_ids references unknown '${artifactId}'`);
					}
					if (localIds.has(artifactId)) {
						errors.push(`${prefix}.artifact_ids duplicates '${artifactId}'`);
					}
					localIds.add(artifactId);
					usedArtifacts.add(artifactId);
				}
			}
		}
	}
	for (const artifactId of artifactIds) {
		if (!usedArtifacts.has(artifactId))
			errors.push(`artifact '${artifactId}' is not used by a source`);
	}
	return errors;
}

export function validatePublicSelection(document, catalog) {
	const errors = [];
	if (!isObject(document)) return ['public corpus selection must be an object'];
	rejectUnknownFields(
		document,
		new Set([
			'schema_version',
			'corpus_id',
			'source_catalog_id',
			'minimum_free_bytes',
			'approved_ffmpeg',
			'fleurs',
			'natural_samples',
		]),
		'selection',
		errors,
	);
	if (document.schema_version !== PUBLIC_SELECTION_SCHEMA_VERSION) {
		errors.push(`selection.schema_version must be ${PUBLIC_SELECTION_SCHEMA_VERSION}`);
	}
	if (
		!requiredString(document.corpus_id, 'selection.corpus_id', errors) ||
		!SLUG_PATTERN.test(document.corpus_id)
	) {
		errors.push('selection.corpus_id must be a lowercase slug');
	}
	if (document.source_catalog_id !== catalog?.catalog_id) {
		errors.push('selection.source_catalog_id must match catalog.catalog_id');
	}
	if (!Number.isSafeInteger(document.minimum_free_bytes) || document.minimum_free_bytes < 0) {
		errors.push('selection.minimum_free_bytes must be a non-negative safe integer');
	}
	const ffmpegIds = new Set();
	if (!Array.isArray(document.approved_ffmpeg) || document.approved_ffmpeg.length === 0) {
		errors.push('selection.approved_ffmpeg must be a non-empty array');
	} else {
		for (const [index, toolchain] of document.approved_ffmpeg.entries()) {
			const prefix = `selection.approved_ffmpeg[${index}]`;
			if (!isObject(toolchain)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			rejectUnknownFields(toolchain, new Set(['id', 'sha256', 'version']), prefix, errors);
			if (!SLUG_PATTERN.test(toolchain.id ?? ''))
				errors.push(`${prefix}.id must be a lowercase slug`);
			if (ffmpegIds.has(toolchain.id)) errors.push(`${prefix}.id is duplicated`);
			ffmpegIds.add(toolchain.id);
			if (
				!SHA256_PATTERN.test(toolchain.sha256 ?? '') ||
				/^([a-f0-9])\1{63}$/.test(toolchain.sha256)
			) {
				errors.push(`${prefix}.sha256 must be a non-placeholder lowercase SHA-256 digest`);
			}
			if (
				!requiredString(toolchain.version, `${prefix}.version`, errors) ||
				toolchain.version.length > 160 ||
				/[\0\r\n]/.test(toolchain.version)
			) {
				errors.push(`${prefix}.version must be a bounded single-line string`);
			}
		}
	}

	const sourceIds = new Set(catalog?.sources?.map((source) => source.id) ?? []);
	if (!isObject(document.fleurs)) {
		errors.push('selection.fleurs must be an object');
	} else {
		const fleurs = document.fleurs;
		rejectUnknownFields(
			fleurs,
			new Set([
				'composites_per_language',
				'minimum_seconds',
				'target_seconds',
				'maximum_seconds',
				'inter_utterance_gap_seconds',
				'sources',
				'conditions',
			]),
			'selection.fleurs',
			errors,
		);
		if (!Number.isInteger(fleurs.composites_per_language) || fleurs.composites_per_language < 1) {
			errors.push('selection.fleurs.composites_per_language must be positive');
		}
		for (const field of ['minimum_seconds', 'target_seconds', 'maximum_seconds']) {
			if (typeof fleurs[field] !== 'number' || fleurs[field] <= 0) {
				errors.push(`selection.fleurs.${field} must be positive`);
			}
		}
		if (
			typeof fleurs.inter_utterance_gap_seconds !== 'number' ||
			fleurs.inter_utterance_gap_seconds < 0 ||
			fleurs.inter_utterance_gap_seconds > 5
		) {
			errors.push('selection.fleurs.inter_utterance_gap_seconds must be between 0 and 5');
		}
		if (
			typeof fleurs.minimum_seconds === 'number' &&
			typeof fleurs.target_seconds === 'number' &&
			typeof fleurs.maximum_seconds === 'number' &&
			!(
				fleurs.minimum_seconds <= fleurs.target_seconds &&
				fleurs.target_seconds <= fleurs.maximum_seconds
			)
		) {
			errors.push('selection.fleurs duration bounds must be ordered minimum <= target <= maximum');
		}
		const languages = new Set();
		for (const [index, source] of (fleurs.sources ?? []).entries()) {
			const prefix = `selection.fleurs.sources[${index}]`;
			if (!isObject(source)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			rejectUnknownFields(
				source,
				new Set(['source_id', 'language', 'whisper_language', 'composites']),
				prefix,
				errors,
			);
			if (!sourceIds.has(source.source_id)) errors.push(`${prefix}.source_id is unknown`);
			if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(source.language ?? '')) {
				errors.push(`${prefix}.language must be a BCP-47-style tag`);
			}
			if (!/^[a-z]{2,3}$/.test(source.whisper_language ?? '')) {
				errors.push(`${prefix}.whisper_language must be a Whisper language code`);
			}
			if (languages.has(source.language)) errors.push(`${prefix}.language is duplicated`);
			languages.add(source.language);
			if (
				!Array.isArray(source.composites) ||
				source.composites.length !== fleurs.composites_per_language
			) {
				errors.push(`${prefix}.composites must commit every configured composite`);
			} else {
				for (const [compositeIndex, composite] of source.composites.entries()) {
					const compositePrefix = `${prefix}.composites[${compositeIndex}]`;
					if (!isObject(composite)) {
						errors.push(`${compositePrefix} must be an object`);
						continue;
					}
					rejectUnknownFields(
						composite,
						new Set([
							'index',
							'member_count',
							'ordered_members_sha256',
							'clean_duration_seconds',
							'overlap_duration_seconds',
							'audio_sha256',
						]),
						compositePrefix,
						errors,
					);
					if (composite.index !== compositeIndex + 1) {
						errors.push(`${compositePrefix}.index must match its deterministic position`);
					}
					if (!Number.isInteger(composite.member_count) || composite.member_count < 1) {
						errors.push(`${compositePrefix}.member_count must be positive`);
					}
					if (!SHA256_PATTERN.test(composite.ordered_members_sha256 ?? '')) {
						errors.push(`${compositePrefix}.ordered_members_sha256 must be a SHA-256 digest`);
					}
					if (
						typeof composite.clean_duration_seconds !== 'number' ||
						composite.clean_duration_seconds < fleurs.minimum_seconds ||
						composite.clean_duration_seconds > fleurs.maximum_seconds
					) {
						errors.push(
							`${compositePrefix}.clean_duration_seconds is outside the committed bounds`,
						);
					}
					if (
						typeof composite.overlap_duration_seconds !== 'number' ||
						composite.overlap_duration_seconds <= 0 ||
						composite.overlap_duration_seconds > composite.clean_duration_seconds
					) {
						errors.push(`${compositePrefix}.overlap_duration_seconds must be positive and bounded`);
					}
					if (!isObject(composite.audio_sha256)) {
						errors.push(`${compositePrefix}.audio_sha256 must commit all four outputs`);
					} else {
						rejectUnknownFields(
							composite.audio_sha256,
							CONDITION_IDS,
							`${compositePrefix}.audio_sha256`,
							errors,
						);
						for (const conditionId of CONDITION_IDS) {
							const digest = composite.audio_sha256[conditionId] ?? '';
							if (!SHA256_PATTERN.test(digest) || /^([a-f0-9])\1{63}$/.test(digest)) {
								errors.push(
									`${compositePrefix}.audio_sha256.${conditionId} must be a non-placeholder SHA-256 digest`,
								);
							}
						}
					}
				}
			}
		}
		if (!Array.isArray(fleurs.sources) || fleurs.sources.length === 0) {
			errors.push('selection.fleurs.sources must be a non-empty array');
		}
		const conditions = new Set();
		for (const [index, condition] of (fleurs.conditions ?? []).entries()) {
			const prefix = `selection.fleurs.conditions[${index}]`;
			if (!isObject(condition)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			rejectUnknownFields(condition, new Set(['id', 'transform_id', 'speakers']), prefix, errors);
			if (!CONDITION_IDS.has(condition.id)) errors.push(`${prefix}.id is unsupported`);
			if (conditions.has(condition.id)) errors.push(`${prefix}.id is duplicated`);
			conditions.add(condition.id);
			if (!SLUG_PATTERN.test(condition.transform_id ?? '')) {
				errors.push(`${prefix}.transform_id must be a lowercase slug`);
			}
			if (!Number.isInteger(condition.speakers) || condition.speakers < 1) {
				errors.push(`${prefix}.speakers must be a positive integer`);
			}
		}
		if (
			conditions.size !== CONDITION_IDS.size ||
			[...CONDITION_IDS].some((id) => !conditions.has(id))
		) {
			errors.push('selection.fleurs.conditions must contain the four paired public conditions');
		}
	}

	const sampleIds = new Set();
	if (!Array.isArray(document.natural_samples) || document.natural_samples.length === 0) {
		errors.push('selection.natural_samples must be a non-empty array');
	} else {
		for (const [index, sample] of document.natural_samples.entries()) {
			const prefix = `selection.natural_samples[${index}]`;
			if (!isObject(sample)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			rejectUnknownFields(
				sample,
				new Set([
					'id',
					'source_id',
					'source_item_id',
					'language',
					'whisper_language',
					'scenario',
					'noise_condition',
					'speakers',
					'duration_seconds',
					'window',
					'transform_id',
					'requires_manual_reference',
					'audio_sha256',
				]),
				prefix,
				errors,
			);
			if (!SLUG_PATTERN.test(sample.id ?? '')) errors.push(`${prefix}.id must be a lowercase slug`);
			if (sampleIds.has(sample.id)) errors.push(`${prefix}.id is duplicated`);
			sampleIds.add(sample.id);
			if (!sourceIds.has(sample.source_id)) errors.push(`${prefix}.source_id is unknown`);
			for (const field of ['source_item_id', 'scenario', 'noise_condition']) {
				requiredString(sample[field], `${prefix}.${field}`, errors);
			}
			if (!SLUG_PATTERN.test(sample.noise_condition ?? '')) {
				errors.push(`${prefix}.noise_condition must be a lowercase slug`);
			}
			if (!SLUG_PATTERN.test(sample.transform_id ?? '')) {
				errors.push(`${prefix}.transform_id must be a lowercase slug`);
			}
			if (!Number.isInteger(sample.speakers) || sample.speakers < 2) {
				errors.push(`${prefix}.speakers must be at least 2`);
			}
			if (typeof sample.duration_seconds !== 'number' || sample.duration_seconds <= 0) {
				errors.push(`${prefix}.duration_seconds must be positive`);
			}
			if (
				!isObject(sample.window) ||
				!['fixed', 'densest-timed-words'].includes(sample.window.strategy)
			) {
				errors.push(`${prefix}.window must declare a supported strategy`);
			} else if (sample.window.strategy === 'fixed') {
				rejectUnknownFields(
					sample.window,
					new Set([
						'strategy',
						'start_seconds',
						'alignment_context_seconds',
						'expected_alignment_hypothesis_tokens',
						'expected_alignment_reference_tokens',
						'expected_alignment_edit_distance',
						'expected_reference_start_token_index',
						'expected_reference_end_token_index',
						'expected_reference_token_count',
						'expected_reference_seed_sha256',
					]),
					`${prefix}.window`,
					errors,
				);
				if (typeof sample.window.start_seconds !== 'number' || sample.window.start_seconds < 0) {
					errors.push(`${prefix}.window.start_seconds must be non-negative`);
				}
				if (sample.source_id?.startsWith('earnings21-')) {
					if (
						typeof sample.window.alignment_context_seconds !== 'number' ||
						sample.window.alignment_context_seconds <= 0
					) {
						errors.push(`${prefix}.window.alignment_context_seconds must be positive`);
					}
					for (const field of [
						'expected_alignment_hypothesis_tokens',
						'expected_alignment_reference_tokens',
						'expected_reference_token_count',
					]) {
						if (!Number.isInteger(sample.window[field]) || sample.window[field] < 1) {
							errors.push(`${prefix}.window.${field} must be a positive integer`);
						}
					}
					for (const field of [
						'expected_alignment_edit_distance',
						'expected_reference_start_token_index',
						'expected_reference_end_token_index',
					]) {
						if (!Number.isInteger(sample.window[field]) || sample.window[field] < 0) {
							errors.push(`${prefix}.window.${field} must be a non-negative integer`);
						}
					}
					if (
						Number.isInteger(sample.window.expected_reference_start_token_index) &&
						Number.isInteger(sample.window.expected_reference_end_token_index) &&
						Number.isInteger(sample.window.expected_reference_token_count) &&
						sample.window.expected_reference_end_token_index -
							sample.window.expected_reference_start_token_index +
							1 !==
							sample.window.expected_reference_token_count
					) {
						errors.push(`${prefix}.window expected reference token bounds do not match its count`);
					}
					if (!SHA256_PATTERN.test(sample.window.expected_reference_seed_sha256 ?? '')) {
						errors.push(`${prefix}.window.expected_reference_seed_sha256 must be a SHA-256 digest`);
					}
					if (sample.requires_manual_reference === true) {
						errors.push(`${prefix}.requires_manual_reference must be false for aligned references`);
					}
				}
			} else {
				rejectUnknownFields(
					sample.window,
					new Set([
						'strategy',
						'grid_seconds',
						'expected_start_seconds',
						'expected_end_seconds',
						'expected_word_count',
						'annotation_member_count',
						'ordered_annotation_members_sha256',
					]),
					`${prefix}.window`,
					errors,
				);
				if (!Number.isInteger(sample.window.grid_seconds) || sample.window.grid_seconds < 1) {
					errors.push(`${prefix}.window.grid_seconds must be a positive integer`);
				}
				if (
					typeof sample.window.expected_start_seconds !== 'number' ||
					sample.window.expected_start_seconds < 0 ||
					sample.window.expected_end_seconds !==
						sample.window.expected_start_seconds + sample.duration_seconds
				) {
					errors.push(`${prefix}.window must commit the exact selected duration`);
				}
				for (const field of ['expected_word_count', 'annotation_member_count']) {
					if (!Number.isInteger(sample.window[field]) || sample.window[field] < 1) {
						errors.push(`${prefix}.window.${field} must be positive`);
					}
				}
				if (!SHA256_PATTERN.test(sample.window.ordered_annotation_members_sha256 ?? '')) {
					errors.push(
						`${prefix}.window.ordered_annotation_members_sha256 must be a SHA-256 digest`,
					);
				}
			}
			if (
				!SHA256_PATTERN.test(sample.audio_sha256 ?? '') ||
				/^([a-f0-9])\1{63}$/.test(sample.audio_sha256)
			) {
				errors.push(`${prefix}.audio_sha256 must be a non-placeholder SHA-256 digest`);
			}
		}
	}
	const expectedSampleCount =
		(document.fleurs?.sources?.length ?? 0) *
			(document.fleurs?.composites_per_language ?? 0) *
			(document.fleurs?.conditions?.length ?? 0) +
		(document.natural_samples?.length ?? 0);
	if (expectedSampleCount !== 66) {
		errors.push(`selection must describe exactly 66 public samples, got ${expectedSampleCount}`);
	}
	return errors;
}

export function loadPublicCorpusConfig(catalogPath, selectionPath, options = {}) {
	const catalog = readJsonFile(catalogPath, 'public source catalog');
	const catalogErrors = validateSourceCatalog(catalog, options);
	if (catalogErrors.length > 0)
		throw new Error(`invalid public source catalog:\n- ${catalogErrors.join('\n- ')}`);
	const selection = readJsonFile(selectionPath, 'public corpus selection');
	const selectionErrors = validatePublicSelection(selection, catalog);
	if (selectionErrors.length > 0)
		throw new Error(`invalid public corpus selection:\n- ${selectionErrors.join('\n- ')}`);
	return { catalog, selection };
}

export function expectedPublicSampleIds(selection) {
	const ids = [];
	for (const source of selection.fleurs.sources) {
		for (let index = 1; index <= selection.fleurs.composites_per_language; index += 1) {
			const baseId = `${source.whisper_language}-fleurs-${String(index).padStart(2, '0')}`;
			for (const condition of selection.fleurs.conditions) ids.push(`${baseId}-${condition.id}`);
		}
	}
	ids.push(...selection.natural_samples.map((sample) => sample.id));
	return ids.sort();
}

function expectedPreparedContracts(selection) {
	const contracts = new Map();
	for (const source of selection.fleurs.sources) {
		for (let index = 1; index <= selection.fleurs.composites_per_language; index += 1) {
			const baseId = `${source.whisper_language}-fleurs-${String(index).padStart(2, '0')}`;
			const composite = source.composites[index - 1];
			for (const condition of selection.fleurs.conditions) {
				const id = `${baseId}-${condition.id}`;
				const durationSeconds =
					condition.id === 'synthetic-overlap'
						? composite.overlap_duration_seconds
						: composite.clean_duration_seconds;
				contracts.set(id, {
					audio_path: `audio/${id}.wav`,
					reference_path: `references/${baseId}.txt`,
					dataset: 'fleurs',
					language: source.language,
					whisper_language: source.whisper_language,
					scenario: 'read-speech',
					noise_condition: condition.id,
					speakers: condition.speakers,
					source_id: source.source_id,
					transform_id: condition.transform_id,
					requires_manual_reference: false,
					duration_seconds: durationSeconds,
					audio_sha256: composite.audio_sha256[condition.id],
					source_window: {
						strategy: 'committed-fleurs-composite',
						composite_index: index,
						gap_seconds: selection.fleurs.inter_utterance_gap_seconds,
						member_count: composite.member_count,
						ordered_members_sha256: composite.ordered_members_sha256,
						expected_duration_seconds: durationSeconds,
					},
					source_member_count: composite.member_count,
					ordered_members_sha256: composite.ordered_members_sha256,
				});
			}
		}
	}
	for (const sample of selection.natural_samples) {
		const dataset = sample.source_id.startsWith('ami-') ? 'ami' : 'earnings21';
		const sourceWindow =
			sample.window.strategy === 'densest-timed-words'
				? {
						strategy: sample.window.strategy,
						start_seconds: sample.window.expected_start_seconds,
						end_seconds: sample.window.expected_end_seconds,
						boundary_policy: 'exclude-crossing-words',
						word_count: sample.window.expected_word_count,
						annotation_member_count: sample.window.annotation_member_count,
						ordered_annotation_members_sha256: sample.window.ordered_annotation_members_sha256,
					}
				: {
						strategy: 'fixed',
						start_seconds: sample.window.start_seconds,
						end_seconds: sample.window.start_seconds + sample.duration_seconds,
						boundary_policy: 'exclude-crossing-anchor-words',
						reference_policy: 'public-human-reference-aligned-to-pinned-timed-hypothesis',
						alignment_artifact_id: `${sample.source_id}-alignment`,
						alignment_context_seconds: sample.window.alignment_context_seconds,
						alignment_hypothesis_tokens: sample.window.expected_alignment_hypothesis_tokens,
						alignment_reference_tokens: sample.window.expected_alignment_reference_tokens,
						alignment_edit_distance: sample.window.expected_alignment_edit_distance,
						reference_start_token_index: sample.window.expected_reference_start_token_index,
						reference_end_token_index: sample.window.expected_reference_end_token_index,
						reference_token_count: sample.window.expected_reference_token_count,
						reference_seed_sha256: sample.window.expected_reference_seed_sha256,
					};
		contracts.set(sample.id, {
			audio_path: `audio/${sample.id}.wav`,
			reference_path: `references/${sample.id}.txt`,
			dataset,
			language: sample.language,
			whisper_language: sample.whisper_language,
			scenario: sample.scenario,
			noise_condition: sample.noise_condition,
			speakers: sample.speakers,
			source_id: sample.source_id,
			source_item_id: sample.source_item_id,
			transform_id: sample.transform_id,
			requires_manual_reference: sample.requires_manual_reference === true,
			duration_seconds: sample.duration_seconds,
			audio_sha256: sample.audio_sha256,
			source_window: sourceWindow,
			...(sample.scenario === 'meeting' ? { session_id: `session-${sample.source_id}` } : {}),
		});
	}
	return contracts;
}

function validatePreparedSampleContract(sample, contract, catalog, errors) {
	const prefix = `prepared sample '${sample.id}'`;
	for (const field of [
		'audio_path',
		'reference_path',
		'dataset',
		'language',
		'whisper_language',
		'scenario',
		'noise_condition',
	]) {
		if (sample[field] !== contract[field]) {
			errors.push(`${prefix}.${field} does not match the committed selection`);
		}
	}
	if (contract.session_id !== sample.session_id) {
		errors.push(`${prefix}.session_id does not match the committed selection`);
	}
	if (sample.speakers !== contract.speakers) {
		errors.push(`${prefix}.speakers does not match the committed selection`);
	}
	if (
		typeof sample.duration_seconds !== 'number' ||
		Math.abs(sample.duration_seconds - contract.duration_seconds) > 0.001
	) {
		errors.push(`${prefix}.duration_seconds does not match the committed selection`);
	}
	if (
		JSON.stringify(canonicalJsonValue(sample.source_window)) !==
		JSON.stringify(canonicalJsonValue(contract.source_window))
	) {
		errors.push(`${prefix}.source_window does not match the committed selection`);
	}
	if (sample.audio_sha256 !== contract.audio_sha256) {
		errors.push(`${prefix}.audio_sha256 does not match the committed deterministic output`);
	}
	if ((sample.requires_manual_reference === true) !== contract.requires_manual_reference) {
		errors.push(`${prefix}.requires_manual_reference does not match the committed selection`);
	}
	const provenance = sample.provenance;
	if (
		provenance?.basis !== 'public-license' ||
		provenance?.redistribution !== 'local-only' ||
		provenance?.source_catalog_id !== catalog.catalog_id ||
		provenance?.transform_id !== contract.transform_id
	) {
		errors.push(`${prefix}.provenance does not match the committed source and transform`);
		return;
	}
	if (!Array.isArray(provenance.source_item_ids) || provenance.source_item_ids.length === 0) {
		errors.push(`${prefix}.provenance.source_item_ids must be non-empty`);
		return;
	}
	if (contract.source_item_id) {
		if (
			provenance.source_item_ids.length !== 1 ||
			provenance.source_item_ids[0] !== contract.source_item_id
		) {
			errors.push(`${prefix}.provenance.source_item_ids does not match the selected natural item`);
		}
		return;
	}
	const expectedPrefix = `${contract.source_id}:`;
	const sourceItems = new Set();
	for (const sourceItemId of provenance.source_item_ids) {
		if (
			typeof sourceItemId !== 'string' ||
			!sourceItemId.startsWith(expectedPrefix) ||
			!/^\d+\.wav$/.test(sourceItemId.slice(expectedPrefix.length))
		) {
			errors.push(
				`${prefix}.provenance.source_item_ids contains an item outside '${contract.source_id}'`,
			);
		}
		if (sourceItems.has(sourceItemId)) {
			errors.push(`${prefix}.provenance.source_item_ids contains duplicate '${sourceItemId}'`);
		}
		sourceItems.add(sourceItemId);
	}
	if (
		sourceItems.size !== contract.source_member_count ||
		sha256Text(
			JSON.stringify(
				provenance.source_item_ids.map((sourceItemId) => sourceItemId.slice(expectedPrefix.length)),
			),
		) !== contract.ordered_members_sha256
	) {
		errors.push(
			`${prefix}.provenance.source_item_ids does not match the exact committed composite`,
		);
	}
}

export function ensurePrivateDirectory(directory, label = 'public corpus directory') {
	const absolute = path.resolve(directory);
	const parsed = path.parse(absolute);
	let current = parsed.root;
	let createdFinal = false;
	for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		let entry = fs.lstatSync(current, { throwIfNoEntry: false });
		if (!entry) {
			fs.mkdirSync(current, { mode: 0o700 });
			entry = fs.lstatSync(current);
			if (current === absolute) createdFinal = true;
		}
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`${label} ancestor must be a real directory: ${current}`);
		}
		const canonical = fs.realpathSync(current);
		const samePath =
			process.platform === 'win32'
				? canonical.toLowerCase() === current.toLowerCase()
				: canonical === current;
		if (!samePath) throw new Error(`${label} ancestor cannot be an alias: ${current}`);
	}
	const finalEntry = fs.lstatSync(absolute);
	if (createdFinal || (finalEntry.mode & 0o077) !== 0) fs.chmodSync(absolute, 0o700);
	return absolute;
}

export function resolveInside(root, relativePath, label = 'path') {
	if (!isSafeRelativePath(relativePath)) {
		throw new Error(`${label} must be a safe relative path: ${relativePath}`);
	}
	const absoluteRoot = path.resolve(root);
	const resolved = path.resolve(absoluteRoot, relativePath);
	if (!resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
		throw new Error(`${label} escapes its root: ${relativePath}`);
	}
	return resolved;
}

function assertRegularFile(filePath, label) {
	const entry = fs.lstatSync(filePath, { throwIfNoEntry: false });
	if (!entry?.isFile() || entry.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file: ${filePath}`);
	}
	if (entry.nlink !== 1) throw new Error(`${label} must not be hard-linked: ${filePath}`);
	return entry;
}

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function openedIdentity(descriptor, label) {
	const status = fs.fstatSync(descriptor, { bigint: true });
	if (!status.isFile()) throw new Error(`${label} must be a regular file`);
	if (status.nlink !== 1n) throw new Error(`${label} must not be hard-linked`);
	return status;
}

function sameOpenedIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function openStableFile(filePath, flags, mode, label) {
	const descriptor = fs.openSync(filePath, flags | NO_FOLLOW, mode);
	try {
		const opened = openedIdentity(descriptor, label);
		const named = fs.lstatSync(filePath, { bigint: true });
		if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n) {
			throw new Error(`${label} must be a regular single-link file: ${filePath}`);
		}
		if (!sameOpenedIdentity(opened, named)) {
			throw new Error(`${label} changed while it was opened: ${filePath}`);
		}
		return { descriptor, path: filePath, identity: opened, label };
	} catch (error) {
		fs.closeSync(descriptor);
		throw error;
	}
}

function attestStableFile(opened, options = {}) {
	const descriptorStatus = openedIdentity(opened.descriptor, opened.label);
	const named = fs.lstatSync(opened.path, { bigint: true, throwIfNoEntry: false });
	if (
		!named?.isFile() ||
		named.isSymbolicLink() ||
		named.nlink !== 1n ||
		!sameOpenedIdentity(descriptorStatus, named) ||
		!sameOpenedIdentity(opened.identity, descriptorStatus)
	) {
		throw new Error(`${opened.label} changed while open: ${opened.path}`);
	}
	if (
		options.requireUnchangedContents &&
		(descriptorStatus.size !== opened.identity.size ||
			descriptorStatus.mtimeNs !== opened.identity.mtimeNs ||
			descriptorStatus.ctimeNs !== opened.identity.ctimeNs)
	) {
		throw new Error(`${opened.label} contents changed while open: ${opened.path}`);
	}
	return descriptorStatus;
}

function refreshStableFileIdentity(opened) {
	const status = attestStableFile(opened);
	opened.identity = status;
	return status;
}

function sha256Descriptor(descriptor, size) {
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	let offset = 0;
	while (offset < size) {
		const bytesRead = fs.readSync(
			descriptor,
			buffer,
			0,
			Math.min(buffer.length, size - offset),
			offset,
		);
		if (bytesRead === 0) throw new Error('file changed or ended while hashing');
		hash.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return hash.digest('hex');
}

function verifyOpenedPinnedArtifact(opened, artifact) {
	const status = attestStableFile(opened);
	const size = Number(status.size);
	if (size !== artifact.size_bytes) {
		throw new Error(
			`artifact '${artifact.id}' size mismatch: expected ${artifact.size_bytes}, got ${size}`,
		);
	}
	const digest = sha256Descriptor(opened.descriptor, size);
	attestStableFile(opened, { requireUnchangedContents: true });
	if (digest !== artifact.sha256) {
		throw new Error(
			`artifact '${artifact.id}' SHA-256 mismatch: expected ${artifact.sha256}, got ${digest}`,
		);
	}
}

function openExistingStableFile(filePath, label) {
	return openStableFile(filePath, fs.constants.O_RDONLY, 0o600, label);
}

function openOrCreateStablePartial(filePath, label) {
	try {
		return openStableFile(
			filePath,
			fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
			0o600,
			label,
		);
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
		return openStableFile(filePath, fs.constants.O_RDWR, 0o600, label);
	}
}

function publishOpenedPinnedArtifact(opened, destination, artifact) {
	attestStableFile(opened, { requireUnchangedContents: true });
	try {
		fs.linkSync(opened.path, destination);
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
		verifyPinnedArtifactFile(destination, artifact);
		attestStableFile(opened, { requireUnchangedContents: true });
		fs.unlinkSync(opened.path);
		return false;
	}
	const destinationStatus = fs.lstatSync(destination, { bigint: true });
	const linkedStatus = fs.fstatSync(opened.descriptor, { bigint: true });
	if (
		!destinationStatus.isFile() ||
		destinationStatus.isSymbolicLink() ||
		!sameOpenedIdentity(destinationStatus, linkedStatus) ||
		linkedStatus.nlink !== 2n
	) {
		throw new Error(`published artifact '${artifact.id}' changed during no-clobber linking`);
	}
	fs.unlinkSync(opened.path);
	opened.path = destination;
	opened.identity = fs.fstatSync(opened.descriptor, { bigint: true });
	attestStableFile(opened, { requireUnchangedContents: true });
	return true;
}

function recoverInterruptedArtifactPublication(destination, partial, artifact) {
	const destinationStatus = fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
	const partialStatus = fs.lstatSync(partial, { bigint: true, throwIfNoEntry: false });
	if (
		!destinationStatus?.isFile() ||
		destinationStatus.isSymbolicLink() ||
		destinationStatus.nlink !== 2n ||
		!partialStatus?.isFile() ||
		partialStatus.isSymbolicLink() ||
		partialStatus.nlink !== 2n ||
		!sameOpenedIdentity(destinationStatus, partialStatus)
	) {
		return false;
	}
	const descriptor = fs.openSync(destination, fs.constants.O_RDONLY | NO_FOLLOW);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (
			!opened.isFile() ||
			opened.nlink !== 2n ||
			!sameOpenedIdentity(opened, destinationStatus) ||
			Number(opened.size) !== artifact.size_bytes ||
			sha256Descriptor(descriptor, Number(opened.size)) !== artifact.sha256
		) {
			throw new Error(
				`interrupted publication for artifact '${artifact.id}' is not pinned content`,
			);
		}
		const destinationBeforeUnlink = fs.lstatSync(destination, { bigint: true });
		const partialBeforeUnlink = fs.lstatSync(partial, { bigint: true });
		if (
			!sameOpenedIdentity(opened, destinationBeforeUnlink) ||
			!sameOpenedIdentity(opened, partialBeforeUnlink)
		) {
			throw new Error(
				`interrupted publication for artifact '${artifact.id}' changed during recovery`,
			);
		}
		fs.unlinkSync(partial);
		const recovered = fs.fstatSync(descriptor, { bigint: true });
		const named = fs.lstatSync(destination, { bigint: true });
		if (
			recovered.nlink !== 1n ||
			named.nlink !== 1n ||
			!sameOpenedIdentity(recovered, named) ||
			!sameOpenedIdentity(recovered, opened)
		) {
			throw new Error(`artifact '${artifact.id}' did not recover to one stable cache name`);
		}
		return true;
	} finally {
		fs.closeSync(descriptor);
	}
}

export function artifactCachePath(cacheRoot, artifact) {
	return resolveInside(cacheRoot, artifact.cache_path, `artifact '${artifact.id}'.cache_path`);
}

export function verifyPinnedArtifactFile(filePath, artifact) {
	const opened = openExistingStableFile(filePath, `artifact '${artifact.id}'`);
	try {
		verifyOpenedPinnedArtifact(opened, artifact);
	} finally {
		fs.closeSync(opened.descriptor);
	}
}

export async function downloadPinnedArtifact(artifact, cacheRoot, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable in this runtime');
	ensurePrivateDirectory(cacheRoot, 'public corpus cache');
	const destination = artifactCachePath(cacheRoot, artifact);
	ensurePrivateDirectory(path.dirname(destination), `artifact '${artifact.id}' cache directory`);
	const partial = `${destination}.part`;
	const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
	if (existing) {
		recoverInterruptedArtifactPublication(destination, partial, artifact);
		verifyPinnedArtifactFile(destination, artifact);
		return { path: destination, downloaded: false, resumed: false };
	}

	const opened = openOrCreateStablePartial(partial, `artifact '${artifact.id}' partial download`);
	let offset = Number(opened.identity.size);
	try {
		if (offset > artifact.size_bytes) {
			fs.ftruncateSync(opened.descriptor, 0);
			fs.fsyncSync(opened.descriptor);
			refreshStableFileIdentity(opened);
			offset = 0;
		}
		if (offset === artifact.size_bytes) {
			try {
				verifyOpenedPinnedArtifact(opened, artifact);
				publishOpenedPinnedArtifact(opened, destination, artifact);
				return { path: destination, downloaded: true, resumed: true };
			} catch (error) {
				if (!String(error.message).includes('SHA-256 mismatch')) throw error;
				fs.ftruncateSync(opened.descriptor, 0);
				fs.fsyncSync(opened.descriptor);
				refreshStableFileIdentity(opened);
				offset = 0;
			}
		}

		const requestedOffset = offset;
		const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
		const response = await fetchImpl(artifact.url, { headers, redirect: 'follow' });
		attestStableFile(opened, { requireUnchangedContents: true });
		if (!response.ok || ![200, 206].includes(response.status)) {
			throw new Error(
				`artifact '${artifact.id}' download failed with HTTP ${response.status} ${response.statusText}`,
			);
		}
		let resumed = false;
		if (requestedOffset > 0 && response.status === 206) {
			const contentRange = response.headers.get('content-range');
			const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
			if (
				!match ||
				Number(match[1]) !== requestedOffset ||
				Number(match[2]) !== artifact.size_bytes - 1 ||
				Number(match[3]) !== artifact.size_bytes
			) {
				throw new Error(`artifact '${artifact.id}' returned an invalid Content-Range`);
			}
			resumed = true;
		} else if (response.status === 206) {
			throw new Error(`artifact '${artifact.id}' returned unsolicited partial content`);
		} else if (requestedOffset > 0) {
			fs.ftruncateSync(opened.descriptor, 0);
			fs.fsyncSync(opened.descriptor);
			refreshStableFileIdentity(opened);
			offset = 0;
		}
		if (!response.body) throw new Error(`artifact '${artifact.id}' download returned no body`);
		const remaining = artifact.size_bytes - offset;
		const contentLength = response.headers.get('content-length');
		if (contentLength !== null && Number(contentLength) !== remaining) {
			throw new Error(
				`artifact '${artifact.id}' Content-Length does not match the pinned remaining size`,
			);
		}

		let written = 0;
		for await (const value of response.body) {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			if (chunk.length > remaining - written) {
				throw new Error(`artifact '${artifact.id}' response exceeded the pinned size`);
			}
			attestStableFile(opened);
			let chunkOffset = 0;
			while (chunkOffset < chunk.length) {
				const bytesWritten = fs.writeSync(
					opened.descriptor,
					chunk,
					chunkOffset,
					chunk.length - chunkOffset,
					offset + written + chunkOffset,
				);
				if (bytesWritten === 0) throw new Error(`artifact '${artifact.id}' write made no progress`);
				chunkOffset += bytesWritten;
			}
			written += chunk.length;
		}
		if (written !== remaining) {
			throw new Error(
				`artifact '${artifact.id}' response ended early: expected ${remaining}, got ${written}`,
			);
		}
		fs.fsyncSync(opened.descriptor);
		refreshStableFileIdentity(opened);
		verifyOpenedPinnedArtifact(opened, artifact);
		publishOpenedPinnedArtifact(opened, destination, artifact);
		return { path: destination, downloaded: true, resumed };
	} finally {
		fs.closeSync(opened.descriptor);
	}
}

export async function materializeCatalogArtifacts(catalog, cacheRoot, options = {}) {
	const results = [];
	for (const artifact of catalog.artifacts) {
		const destination = artifactCachePath(cacheRoot, artifact);
		if (fs.existsSync(destination)) {
			verifyPinnedArtifactFile(destination, artifact);
			results.push({ id: artifact.id, path: destination, downloaded: false, resumed: false });
			continue;
		}
		if (!options.allowNetwork) {
			throw new Error(
				`artifact '${artifact.id}' is not cached; rerun with the explicit --download flag`,
			);
		}
		const result = await downloadPinnedArtifact(artifact, cacheRoot, options);
		results.push({ id: artifact.id, ...result });
	}
	return results;
}

function normalizedArchiveName(memberPath) {
	if (typeof memberPath !== 'string') return null;
	const replaced = memberPath.replaceAll('\\', '/').replace(/\/+$/, '');
	return replaced.length === 0 ? null : replaced;
}

export function validateArchiveMemberPaths(memberPaths) {
	const errors = [];
	const normalizedPaths = new Set();
	const portablePaths = new Map();
	for (const [index, memberPath] of memberPaths.entries()) {
		const normalized = normalizedArchiveName(memberPath);
		const prefix = `archive member[${index}]`;
		if (
			!normalized ||
			normalized.includes('\0') ||
			normalized.includes('\n') ||
			normalized.includes('\r') ||
			path.posix.isAbsolute(normalized) ||
			/^[A-Za-z]:/.test(normalized) ||
			normalized.startsWith('//') ||
			normalized
				.split('/')
				.some((part) => part.length === 0 || part === '.' || part === '..' || part.startsWith('-'))
		) {
			errors.push(`${prefix} is unsafe: ${JSON.stringify(memberPath)}`);
			continue;
		}
		if (normalized.normalize('NFC') !== normalized || !/^[\x20-\x7e]+$/.test(normalized)) {
			errors.push(`${prefix} must use canonical printable ASCII to avoid Unicode aliases`);
			continue;
		}
		if (normalizedPaths.has(normalized)) {
			errors.push(`${prefix} duplicates '${normalized}'`);
		}
		normalizedPaths.add(normalized);
		const portable = normalized.toLowerCase();
		const aliased = portablePaths.get(portable);
		if (aliased !== undefined && aliased !== normalized) {
			errors.push(`${prefix} aliases '${aliased}' on a case-insensitive filesystem`);
		}
		portablePaths.set(portable, normalized);
	}
	return errors;
}

export function validateArchiveEntries(entries) {
	const errors = validateArchiveMemberPaths(entries.map((entry) => entry.path));
	for (const [index, entry] of entries.entries()) {
		if (!['file', 'directory'].includes(entry.type)) {
			errors.push(`archive member[${index}] uses forbidden entry type '${entry.type}'`);
		}
	}
	return errors;
}

function verboseEntryTypes(output) {
	return output
		.split(/\r?\n/)
		.filter((line) => /^[-dlhcbps]/.test(line))
		.map((line) => {
			if (line[0] === 'd') return 'directory';
			if (line[0] === '-') return 'file';
			if (line[0] === 'l') return 'symbolic-link';
			if (line[0] === 'h') return 'hard-link';
			return 'special';
		});
}

export function listArchiveEntries(archivePath, archiveFormat, options = {}) {
	assertRegularFile(archivePath, 'archive');
	const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
	let namesOutput;
	let verboseOutput;
	if (archiveFormat === 'tar.gz') {
		namesOutput = execFileSyncImpl('tar', ['-tzf', archivePath], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		verboseOutput = execFileSyncImpl('tar', ['-tvzf', archivePath], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
	} else if (archiveFormat === 'zip') {
		namesOutput = execFileSyncImpl('unzip', ['-Z1', archivePath], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		verboseOutput = execFileSyncImpl('zipinfo', ['-l', archivePath], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
	} else {
		throw new Error(`unsupported archive format '${archiveFormat}'`);
	}
	const names = namesOutput.split(/\r?\n/).filter((name) => name.length > 0);
	const types = verboseEntryTypes(verboseOutput);
	if (names.length !== types.length) {
		throw new Error(
			`could not safely correlate archive names and entry types (${names.length} names, ${types.length} entries)`,
		);
	}
	const entries = names.map((memberPath, index) => ({ path: memberPath, type: types[index] }));
	const errors = validateArchiveEntries(entries);
	if (errors.length > 0) throw new Error(`unsafe archive:\n- ${errors.join('\n- ')}`);
	return entries;
}

export function assertExtractedTree(directory) {
	for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
		const parentPath = entry.parentPath ?? entry.path;
		const entryPath = path.join(parentPath, entry.name);
		const status = fs.lstatSync(entryPath);
		if (status.isSymbolicLink())
			throw new Error(`extracted archive created a symbolic link: ${entryPath}`);
		if (status.isFile() && status.nlink !== 1) {
			throw new Error(`extracted archive created a hard-linked file: ${entryPath}`);
		}
	}
}

export function extractArchiveMembers(
	archivePath,
	archiveFormat,
	destination,
	members,
	options = {},
) {
	const entries = options.entries ?? listArchiveEntries(archivePath, archiveFormat, options);
	const entryByName = new Map(entries.map((entry) => [entry.path, entry]));
	if (!Array.isArray(members) || members.length === 0) {
		throw new Error('at least one archive member must be selected');
	}
	for (const member of members) {
		if (entryByName.get(member)?.type !== 'file') {
			throw new Error(`selected archive member is not a regular file: ${member}`);
		}
	}
	ensurePrivateDirectory(destination, 'archive extraction directory');
	const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
	const maximumExtractedBytes = options.maximumExtractedBytes ?? 512 * 1024 * 1024;
	const maximumMemberBytes = options.maximumMemberBytes ?? maximumExtractedBytes;
	if (
		!Number.isSafeInteger(maximumExtractedBytes) ||
		maximumExtractedBytes <= 0 ||
		!Number.isSafeInteger(maximumMemberBytes) ||
		maximumMemberBytes <= 0
	) {
		throw new Error('archive extraction byte budgets must be positive safe integers');
	}
	let extractedBytes = 0;
	for (const member of members) {
		let contents;
		try {
			if (archiveFormat === 'tar.gz') {
				contents = execFileSyncImpl('tar', ['-xOzf', archivePath, '--', member], {
					encoding: null,
					maxBuffer: Math.min(maximumMemberBytes, maximumExtractedBytes - extractedBytes) + 1,
				});
			} else if (archiveFormat === 'zip') {
				contents = execFileSyncImpl('unzip', ['-p', archivePath, member], {
					encoding: null,
					maxBuffer: Math.min(maximumMemberBytes, maximumExtractedBytes - extractedBytes) + 1,
				});
			} else {
				throw new Error(`unsupported archive format '${archiveFormat}'`);
			}
		} catch (error) {
			throw new Error(`bounded extraction failed for '${member}': ${error.message}`);
		}
		if (!Buffer.isBuffer(contents)) contents = Buffer.from(contents);
		if (contents.length > maximumMemberBytes) {
			throw new Error(`archive member '${member}' exceeds its extraction byte budget`);
		}
		extractedBytes += contents.length;
		if (extractedBytes > maximumExtractedBytes) {
			throw new Error('selected archive members exceed the aggregate extraction byte budget');
		}
		const outputPath = resolveInside(destination, normalizedArchiveName(member), 'archive member');
		ensurePrivateDirectory(path.dirname(outputPath), 'archive member parent');
		fs.writeFileSync(outputPath, contents, { flag: 'wx', mode: 0o600 });
		assertRegularFile(outputPath, `extracted archive member '${member}'`);
	}
	assertExtractedTree(destination);
	return members.map((member) =>
		resolveInside(destination, normalizedArchiveName(member), 'archive member'),
	);
}

export function parseFleursTsv(input, options = {}) {
	const sampleRate = options.sampleRate ?? 16_000;
	let text;
	try {
		text =
			typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
	} catch {
		throw new Error('FLEURS index must be valid UTF-8');
	}
	const rows = [];
	const filenames = new Set();
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (line.length === 0) continue;
		const columns = line.split('\t');
		if (columns.length !== 7) {
			throw new Error(`FLEURS index line ${index + 1} must have exactly seven columns`);
		}
		const [promptId, filename, transcript, normalizedTranscript, , sampleCountText, gender] =
			columns;
		if (!/^\d+\.wav$/.test(filename)) {
			throw new Error(`FLEURS index line ${index + 1} has an unsafe audio filename`);
		}
		if (filenames.has(filename)) throw new Error(`FLEURS index duplicates '${filename}'`);
		filenames.add(filename);
		const sampleCount = Number(sampleCountText);
		if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
			throw new Error(`FLEURS index line ${index + 1} has an invalid sample count`);
		}
		if (transcript.trim().length === 0 || normalizedTranscript.trim().length === 0) {
			throw new Error(`FLEURS index line ${index + 1} has an empty transcript`);
		}
		rows.push({
			promptId,
			filename,
			transcript,
			normalizedTranscript,
			sampleCount,
			durationSeconds: sampleCount / sampleRate,
			gender,
		});
	}
	if (rows.length === 0) throw new Error('FLEURS index is empty');
	return rows;
}

function byteLexicalCompare(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function selectFleursComposites(rows, options) {
	const { count, minimumSeconds, targetSeconds, maximumSeconds, gapSeconds = 0.4 } = options;
	if (
		!Number.isInteger(count) ||
		count < 1 ||
		![minimumSeconds, targetSeconds, maximumSeconds].every(
			(value) => typeof value === 'number' && value > 0,
		) ||
		minimumSeconds > targetSeconds ||
		targetSeconds > maximumSeconds ||
		typeof gapSeconds !== 'number' ||
		gapSeconds < 0
	) {
		throw new Error('invalid FLEURS composite selection bounds');
	}
	const remaining = [...rows].sort((left, right) =>
		byteLexicalCompare(left.filename, right.filename),
	);
	const composites = [];
	let cursor = 0;
	for (let compositeIndex = 0; compositeIndex < count; compositeIndex += 1) {
		const items = [];
		let durationSeconds = 0;
		while (durationSeconds < targetSeconds && cursor < remaining.length) {
			const item = remaining[cursor];
			cursor += 1;
			if (item.durationSeconds > maximumSeconds) continue;
			const addedDuration = item.durationSeconds + (items.length === 0 ? 0 : gapSeconds);
			if (durationSeconds + addedDuration > maximumSeconds) {
				if (durationSeconds >= minimumSeconds) break;
				continue;
			}
			items.push(item);
			durationSeconds += addedDuration;
		}
		if (durationSeconds < minimumSeconds) {
			throw new Error(
				`FLEURS index cannot fill composite ${compositeIndex + 1} to ${minimumSeconds} seconds`,
			);
		}
		composites.push({ items, durationSeconds });
	}
	return composites;
}

export function planOverlapTimings(items, overlapFraction = 0.25) {
	if (typeof overlapFraction !== 'number' || overlapFraction <= 0 || overlapFraction >= 1) {
		throw new Error('overlap fraction must be between zero and one');
	}
	const timings = [];
	for (const [index, item] of items.entries()) {
		if (typeof item.durationSeconds !== 'number' || item.durationSeconds <= 0) {
			throw new Error(`overlap item ${index} has an invalid duration`);
		}
		let onsetSeconds = 0;
		if (index > 0) {
			const previous = timings[index - 1];
			const overlap = Math.min(previous.durationSeconds, item.durationSeconds) * overlapFraction;
			onsetSeconds = previous.onsetSeconds + previous.durationSeconds - overlap;
		}
		timings.push({ ...item, onsetSeconds });
	}
	return timings;
}

function decodeXmlEntities(value) {
	return value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&#39;', "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
		.replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
		.replaceAll('&amp;', '&');
}

function attributeValue(attributes, name) {
	const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
	return match?.[1];
}

export function parseAmiWordDocuments(documents) {
	const words = [];
	let ordinal = 0;
	for (const document of documents) {
		const text = Buffer.isBuffer(document.content)
			? new TextDecoder('latin1').decode(document.content)
			: document.content;
		if (typeof text !== 'string') throw new Error('AMI word document content must be text');
		const expression = /<w\b([^>]*)>([\s\S]*?)<\/w>/g;
		for (let match = expression.exec(text); match; match = expression.exec(text)) {
			const start = Number(attributeValue(match[1], 'starttime'));
			const end = Number(attributeValue(match[1], 'endtime'));
			const token = decodeXmlEntities(match[2]).trim();
			if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || token.length === 0) {
				throw new Error(`AMI word document '${document.speakerId}' contains an invalid timed word`);
			}
			words.push({
				start,
				end,
				text: token,
				punctuation: attributeValue(match[1], 'punc') === 'true',
				speakerId: document.speakerId,
				ordinal,
			});
			ordinal += 1;
		}
	}
	if (words.length === 0) throw new Error('AMI word documents contain no timed words');
	return words.sort(
		(left, right) =>
			left.start - right.start ||
			byteLexicalCompare(left.speakerId, right.speakerId) ||
			left.ordinal - right.ordinal,
	);
}

export function selectDensestTimedWindow(words, durationSeconds, gridSeconds) {
	if (typeof durationSeconds !== 'number' || durationSeconds <= 0) {
		throw new Error('window duration must be positive');
	}
	if (!Number.isInteger(gridSeconds) || gridSeconds < 1) {
		throw new Error('window grid must be a positive integer');
	}
	const timedWords = words.filter(
		(word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start,
	);
	if (timedWords.length === 0) throw new Error('cannot choose a dense window without timed words');
	const finalEnd = Math.max(...timedWords.map((word) => word.end));
	const finalStart = Math.max(0, finalEnd - durationSeconds);
	const candidates = new Set([0, finalStart]);
	for (let start = 0; start <= finalStart; start += gridSeconds) candidates.add(start);
	let best;
	for (const start of [...candidates].sort((left, right) => left - right)) {
		const end = start + durationSeconds;
		const selected = timedWords.filter((word) => word.start >= start && word.end <= end);
		const speechSeconds = selected.reduce(
			(total, word) => total + Math.max(0, Math.min(end, word.end) - Math.max(start, word.start)),
			0,
		);
		const score = { start, end, words: selected, wordCount: selected.length, speechSeconds };
		if (
			!best ||
			score.wordCount > best.wordCount ||
			(score.wordCount === best.wordCount && score.speechSeconds > best.speechSeconds) ||
			(score.wordCount === best.wordCount &&
				score.speechSeconds === best.speechSeconds &&
				score.start < best.start)
		) {
			best = score;
		}
	}
	return best;
}

export function renderTimedReference(words, startSeconds, endSeconds) {
	let reference = '';
	for (const word of words) {
		if (word.start < startSeconds || word.end > endSeconds) continue;
		const text = word.text.trim();
		if (text.length === 0) continue;
		if (word.punctuation || /^[.,?!:;%\])}]+$/.test(text)) {
			reference = `${reference.trimEnd()}${text}`;
		} else {
			reference += `${reference.length === 0 ? '' : ' '}${text}`;
		}
	}
	return `${reference.trim()}\n`;
}

const EARNINGS_REFERENCE_HEADER = 'token|speaker|ts|endTs|punctuation|case|tags|wer_tags';
const EARNINGS_HYPOTHESIS_HEADER = 'token|speaker|ts|endTs|punctuation|case|tags';

function earningsText(input, label) {
	if (typeof input === 'string') return input;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(input);
	} catch {
		throw new Error(`${label} must be valid UTF-8`);
	}
}

export function parseEarningsReference(input) {
	const lines = earningsText(input, 'Earnings-21 reference')
		.split(/\r?\n/)
		.filter((line) => line.length > 0);
	if (lines[0] !== EARNINGS_REFERENCE_HEADER) {
		throw new Error('Earnings-21 reference has an unexpected header');
	}
	const tokens = [];
	for (const [index, line] of lines.slice(1).entries()) {
		const columns = line.split('|');
		if (columns.length !== 8) throw new Error(`Earnings-21 reference line ${index + 2} is invalid`);
		const text = columns[0].trim();
		if (text.length === 0) {
			throw new Error(`Earnings-21 reference line ${index + 2} has an empty token`);
		}
		tokens.push({ text, punctuation: columns[4] });
	}
	if (tokens.length === 0) throw new Error('Earnings-21 reference contains no tokens');
	return tokens;
}

export function parseEarningsTimedHypothesis(input) {
	const lines = earningsText(input, 'Earnings-21 alignment hypothesis')
		.split(/\r?\n/)
		.filter((line) => line.length > 0);
	if (lines[0] !== EARNINGS_HYPOTHESIS_HEADER) {
		throw new Error('Earnings-21 alignment hypothesis has an unexpected header');
	}
	const tokens = [];
	for (const [index, line] of lines.slice(1).entries()) {
		const columns = line.split('|');
		if (columns.length !== 7) {
			throw new Error(`Earnings-21 alignment hypothesis line ${index + 2} is invalid`);
		}
		const text = columns[0].trim();
		const start = Number(columns[2]);
		const end = Number(columns[3]);
		if (
			text.length === 0 ||
			columns[2].trim().length === 0 ||
			columns[3].trim().length === 0 ||
			!Number.isFinite(start) ||
			!Number.isFinite(end) ||
			start < 0 ||
			end < start
		) {
			throw new Error(`Earnings-21 alignment hypothesis line ${index + 2} is invalid`);
		}
		tokens.push({ text, start, end });
	}
	if (tokens.length === 0) throw new Error('Earnings-21 alignment hypothesis contains no tokens');
	return tokens;
}

function normalizedEarningsToken(value) {
	return value
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '');
}

function renderEarningsTokens(tokens) {
	let reference = '';
	for (const token of tokens) {
		reference += `${reference.length === 0 ? '' : ' '}${token.text}`;
		if (token.punctuation) reference += token.punctuation;
	}
	return `${reference.trim()}\n`;
}

export function deriveEarningsReferenceExcerpt(referenceInput, hypothesisInput, options) {
	const { startSeconds, endSeconds, contextSeconds } = options;
	if (
		!Number.isFinite(startSeconds) ||
		!Number.isFinite(endSeconds) ||
		!Number.isFinite(contextSeconds) ||
		startSeconds < 0 ||
		endSeconds <= startSeconds ||
		contextSeconds <= 0
	) {
		throw new Error('Earnings-21 alignment requires a valid window and positive context');
	}
	const reference = parseEarningsReference(referenceInput);
	const hypothesis = parseEarningsTimedHypothesis(hypothesisInput).filter(
		(token) => token.end <= endSeconds + contextSeconds,
	);
	if (hypothesis.length === 0) {
		throw new Error('Earnings-21 alignment context contains no timed hypothesis tokens');
	}

	// The recordings and hypotheses begin at the same origin. Aligning a bounded prefix keeps the
	// dynamic-programming matrix small while the free reference endpoint absorbs token-count drift.
	const referenceLimit = Math.min(reference.length, Math.ceil(hypothesis.length * 1.5) + 256);
	const width = referenceLimit + 1;
	const matrixCells = (hypothesis.length + 1) * width;
	if (!Number.isSafeInteger(matrixCells) || matrixCells > 10_000_000) {
		throw new Error('Earnings-21 alignment matrix exceeds the deterministic safety bound');
	}
	const normalizedReference = reference
		.slice(0, referenceLimit)
		.map((token) => normalizedEarningsToken(token.text));
	const normalizedHypothesis = hypothesis.map((token) => normalizedEarningsToken(token.text));
	const directions = new Uint8Array(matrixCells);
	let previous = new Uint32Array(width);
	let current = new Uint32Array(width);
	for (let referenceIndex = 0; referenceIndex <= referenceLimit; referenceIndex += 1) {
		previous[referenceIndex] = referenceIndex;
		directions[referenceIndex] = 2;
	}
	for (let hypothesisIndex = 1; hypothesisIndex <= hypothesis.length; hypothesisIndex += 1) {
		current[0] = hypothesisIndex;
		directions[hypothesisIndex * width] = 1;
		const hypothesisToken = normalizedHypothesis[hypothesisIndex - 1];
		for (let referenceIndex = 1; referenceIndex <= referenceLimit; referenceIndex += 1) {
			const tokensMatch =
				hypothesisToken.length > 0 && hypothesisToken === normalizedReference[referenceIndex - 1];
			const diagonal = previous[referenceIndex - 1] + (tokensMatch ? 0 : 1);
			const hypothesisInsertion = previous[referenceIndex] + 1;
			const referenceDeletion = current[referenceIndex - 1] + 1;
			let cost = diagonal;
			let direction = 0;
			if (referenceDeletion < cost) {
				cost = referenceDeletion;
				direction = 2;
			}
			if (hypothesisInsertion < cost) {
				cost = hypothesisInsertion;
				direction = 1;
			}
			current[referenceIndex] = cost;
			directions[hypothesisIndex * width + referenceIndex] = direction;
		}
		const swap = previous;
		previous = current;
		current = swap;
	}

	let alignedReferenceTokens = Math.min(referenceLimit, Math.floor(hypothesis.length / 2));
	let editDistance = previous[alignedReferenceTokens];
	for (
		let referenceIndex = alignedReferenceTokens + 1;
		referenceIndex <= referenceLimit;
		referenceIndex += 1
	) {
		if (
			previous[referenceIndex] < editDistance ||
			(previous[referenceIndex] === editDistance && referenceIndex > alignedReferenceTokens)
		) {
			alignedReferenceTokens = referenceIndex;
			editDistance = previous[referenceIndex];
		}
	}

	const hypothesisByReference = new Int32Array(alignedReferenceTokens);
	hypothesisByReference.fill(-1);
	let hypothesisIndex = hypothesis.length;
	let referenceIndex = alignedReferenceTokens;
	let pairedTokens = 0;
	let exactPairs = 0;
	while (hypothesisIndex > 0 || referenceIndex > 0) {
		const direction = directions[hypothesisIndex * width + referenceIndex];
		if (hypothesisIndex > 0 && referenceIndex > 0 && direction === 0) {
			hypothesisByReference[referenceIndex - 1] = hypothesisIndex - 1;
			pairedTokens += 1;
			if (
				normalizedHypothesis[hypothesisIndex - 1].length > 0 &&
				normalizedHypothesis[hypothesisIndex - 1] === normalizedReference[referenceIndex - 1]
			) {
				exactPairs += 1;
			}
			hypothesisIndex -= 1;
			referenceIndex -= 1;
		} else if (hypothesisIndex > 0 && (referenceIndex === 0 || direction === 1)) {
			hypothesisIndex -= 1;
		} else {
			referenceIndex -= 1;
		}
	}

	if (!Number.isFinite(editDistance) || pairedTokens === 0) {
		throw new Error('Earnings-21 alignment did not produce a finite paired path');
	}
	const exactPairRatio = exactPairs / pairedTokens;
	const normalizedEditDistance = editDistance / Math.max(hypothesis.length, alignedReferenceTokens);
	if (
		!Number.isFinite(exactPairRatio) ||
		!Number.isFinite(normalizedEditDistance) ||
		exactPairRatio < 0.8 ||
		normalizedEditDistance > 0.25
	) {
		throw new Error(
			`Earnings-21 alignment quality is unsafe: exact=${exactPairRatio.toFixed(4)}, edit=${normalizedEditDistance.toFixed(4)}`,
		);
	}

	let startAnchor;
	let endAnchor;
	for (let index = 0; index < alignedReferenceTokens; index += 1) {
		const mappedIndex = hypothesisByReference[index];
		if (mappedIndex < 0) continue;
		const timedToken = hypothesis[mappedIndex];
		if (
			normalizedHypothesis[mappedIndex].length === 0 ||
			normalizedHypothesis[mappedIndex] !== normalizedReference[index]
		) {
			continue;
		}
		const anchor = {
			referenceTokenIndex: index,
			hypothesisTokenIndex: mappedIndex,
			start: timedToken.start,
			end: timedToken.end,
		};
		if (!startAnchor && timedToken.start >= startSeconds && timedToken.end <= endSeconds) {
			startAnchor = anchor;
		}
		if (timedToken.start >= startSeconds && timedToken.end <= endSeconds) {
			endAnchor = anchor;
		}
	}
	if (
		!startAnchor ||
		!endAnchor ||
		endAnchor.referenceTokenIndex < startAnchor.referenceTokenIndex
	) {
		throw new Error('Earnings-21 alignment could not resolve exact excerpt boundary anchors');
	}

	const referenceTokens = reference.slice(
		startAnchor.referenceTokenIndex,
		endAnchor.referenceTokenIndex + 1,
	);
	const text = renderEarningsTokens(referenceTokens);
	return {
		text,
		referenceSeedSha256: sha256Text(text),
		hypothesisTokens: hypothesis.length,
		alignedReferenceTokens,
		editDistance,
		pairedTokens,
		exactPairs,
		exactPairRatio,
		normalizedEditDistance,
		referenceStartTokenIndex: startAnchor.referenceTokenIndex,
		referenceEndTokenIndex: endAnchor.referenceTokenIndex,
		referenceTokenCount: referenceTokens.length,
		startAnchor,
		endAnchor,
	};
}

export function renderEarningsContext(input) {
	return renderEarningsTokens(parseEarningsReference(input));
}

export function atomicWriteJson(filePath, document, options = {}) {
	const entry = fs.lstatSync(filePath, { throwIfNoEntry: false });
	if (entry?.isSymbolicLink())
		throw new Error(`JSON output cannot be a symbolic link: ${filePath}`);
	ensurePrivateDirectory(path.dirname(filePath), 'JSON output directory');
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	const descriptor = fs.openSync(temporary, 'wx', options.mode ?? 0o600);
	try {
		fs.writeFileSync(descriptor, `${JSON.stringify(document, null, '\t')}\n`, 'utf8');
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	try {
		fs.renameSync(temporary, filePath);
	} catch (error) {
		fs.unlinkSync(temporary);
		throw error;
	}
	fs.chmodSync(filePath, options.mode ?? 0o600);
	return filePath;
}

function publishJsonNoClobber(filePath, document, options = {}) {
	ensurePrivateDirectory(path.dirname(filePath), 'JSON output directory');
	const contents = Buffer.from(`${JSON.stringify(document, null, '\t')}\n`);
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	const descriptor = fs.openSync(
		temporary,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
		options.mode ?? 0o600,
	);
	try {
		fs.writeFileSync(descriptor, contents);
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	try {
		try {
			fs.linkSync(temporary, filePath);
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
			const existing = openExistingStableFile(filePath, 'existing JSON output');
			try {
				const status = attestStableFile(existing);
				const existingBytes = descriptorContents(
					existing.descriptor,
					Number(status.size),
					'existing JSON output',
					64 * 1024 * 1024,
				);
				attestStableFile(existing, { requireUnchangedContents: true });
				if (!existingBytes.equals(contents)) {
					throw new Error(`refusing to replace different existing JSON output: ${filePath}`);
				}
				return { path: filePath, published: false };
			} finally {
				fs.closeSync(existing.descriptor);
			}
		}
		const published = fs.lstatSync(filePath, { bigint: true });
		const staged = fs.lstatSync(temporary, { bigint: true });
		if (
			!published.isFile() ||
			published.isSymbolicLink() ||
			!sameOpenedIdentity(published, staged)
		) {
			throw new Error(`JSON output changed during no-clobber publication: ${filePath}`);
		}
		return { path: filePath, published: true };
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

export function createReviewTemplate(samples) {
	return {
		schema_version: PUBLIC_REVIEW_SCHEMA_VERSION,
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		samples: samples.map((sample) => ({ sample_id: sample.id, reviewers: [] })),
	};
}

export function writePreparedBundle(workspace, prepared) {
	const preparedPath = path.join(workspace, 'prepared-samples.json');
	const reviewsPath = path.join(workspace, 'review-attestations.json');
	if (!fs.existsSync(reviewsPath)) {
		atomicWriteJson(preparedPath, prepared);
		atomicWriteJson(reviewsPath, createReviewTemplate(prepared.samples));
	} else {
		const reviews = readJsonFile(reviewsPath, 'public reference review attestations');
		const existingIds = new Set(reviews.samples?.map((sample) => sample.sample_id) ?? []);
		const expectedIds = new Set(prepared.samples.map((sample) => sample.id));
		if (
			existingIds.size !== expectedIds.size ||
			[...expectedIds].some((sampleId) => !existingIds.has(sampleId))
		) {
			throw new Error(
				'review-attestations.json does not match the prepared sample set; preserve it for audit and start a fresh workspace',
			);
		}
		atomicWriteJson(preparedPath, prepared);
	}
	return { preparedPath, reviewsPath };
}

function loadPreparedDocument(workspace, catalogPath, selectionPath, catalog, selection) {
	const preparedPath = path.join(workspace, 'prepared-samples.json');
	const prepared = readJsonFile(preparedPath, 'prepared public corpus metadata');
	const errors = [];
	if (!isObject(prepared)) return { prepared, errors: ['prepared metadata must be an object'] };
	rejectUnknownFields(
		prepared,
		new Set([
			'schema_version',
			'corpus_id',
			'source_catalog_id',
			'source_catalog_sha256',
			'selection_sha256',
			'reference_protocol_id',
			'ffmpeg',
			'samples',
		]),
		'prepared',
		errors,
	);
	if (prepared.schema_version !== PUBLIC_PREPARED_SCHEMA_VERSION) {
		errors.push(`prepared.schema_version must be ${PUBLIC_PREPARED_SCHEMA_VERSION}`);
	}
	if (prepared.corpus_id !== selection.corpus_id) {
		errors.push('prepared.corpus_id does not match the selection');
	}
	if (prepared.source_catalog_id !== catalog.catalog_id) {
		errors.push('prepared.source_catalog_id does not match the catalog');
	}
	if (prepared.source_catalog_sha256 !== fileSha256(catalogPath)) {
		errors.push('prepared.source_catalog_sha256 does not match the catalog file');
	}
	if (prepared.selection_sha256 !== fileSha256(selectionPath)) {
		errors.push('prepared.selection_sha256 does not match the selection file');
	}
	if (prepared.reference_protocol_id !== REFERENCE_PROTOCOL_ID) {
		errors.push(`prepared.reference_protocol_id must be '${REFERENCE_PROTOCOL_ID}'`);
	}
	if (!isObject(prepared.ffmpeg)) {
		errors.push('prepared.ffmpeg must identify the approved executable');
	} else {
		rejectUnknownFields(
			prepared.ffmpeg,
			new Set(['id', 'executable_path', 'sha256', 'version']),
			'prepared.ffmpeg',
			errors,
		);
		const approved = selection.approved_ffmpeg.find(
			(toolchain) =>
				toolchain.id === prepared.ffmpeg.id &&
				toolchain.sha256 === prepared.ffmpeg.sha256 &&
				toolchain.version === prepared.ffmpeg.version,
		);
		if (!approved) errors.push('prepared.ffmpeg does not match an approved pinned FFmpeg identity');
		if (
			typeof prepared.ffmpeg.executable_path !== 'string' ||
			!path.isAbsolute(prepared.ffmpeg.executable_path)
		) {
			errors.push('prepared.ffmpeg.executable_path must be absolute');
		} else {
			let opened;
			try {
				const canonical = fs.realpathSync(prepared.ffmpeg.executable_path);
				if (canonical !== prepared.ffmpeg.executable_path) {
					throw new Error('executable path must be canonical');
				}
				opened = openExistingStableFile(canonical, 'prepared FFmpeg executable');
				fs.accessSync(canonical, fs.constants.X_OK);
				const status = attestStableFile(opened);
				const digest = sha256Descriptor(opened.descriptor, Number(status.size));
				if (digest !== prepared.ffmpeg.sha256) throw new Error('executable hash changed');
				const version = execFileSync(canonical, ['-version'], {
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					maxBuffer: 1024 * 1024,
				})
					.split(/\r?\n/, 1)[0]
					.trim();
				attestStableFile(opened, { requireUnchangedContents: true });
				if (version !== prepared.ffmpeg.version) throw new Error('version output changed');
			} catch (error) {
				errors.push(`prepared.ffmpeg executable is invalid: ${error.message}`);
			} finally {
				if (opened) fs.closeSync(opened.descriptor);
			}
		}
	}
	if (!Array.isArray(prepared.samples) || prepared.samples.length === 0) {
		errors.push('prepared.samples must be a non-empty array');
	} else {
		const ids = new Set();
		const contracts = expectedPreparedContracts(selection);
		for (const [index, sample] of prepared.samples.entries()) {
			const prefix = `prepared.samples[${index}]`;
			if (!isObject(sample)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			rejectUnknownFields(
				sample,
				new Set([
					'id',
					'session_id',
					'audio_path',
					'audio_sha256',
					'reference_path',
					'dataset',
					'language',
					'whisper_language',
					'scenario',
					'noise_condition',
					'speakers',
					'duration_seconds',
					'provenance',
					'requires_manual_reference',
					'source_window',
				]),
				prefix,
				errors,
			);
			if (!SLUG_PATTERN.test(sample.id ?? '')) errors.push(`${prefix}.id must be a lowercase slug`);
			if (ids.has(sample.id)) errors.push(`${prefix}.id is duplicated`);
			ids.add(sample.id);
			for (const field of ['audio_path', 'reference_path']) {
				if (!isSafeRelativePath(sample[field]))
					errors.push(`${prefix}.${field} must be a safe relative path`);
			}
			if (!SHA256_PATTERN.test(sample.audio_sha256 ?? '')) {
				errors.push(`${prefix}.audio_sha256 must be a lowercase SHA-256 digest`);
			}
			if (
				sample.provenance?.basis !== 'public-license' ||
				sample.provenance?.redistribution !== 'local-only' ||
				sample.provenance?.source_catalog_id !== catalog.catalog_id
			) {
				errors.push(`${prefix}.provenance must bind to the local-only public source catalog`);
			}
			const contract = contracts.get(sample.id);
			if (contract) validatePreparedSampleContract(sample, contract, catalog, errors);
		}
		const expectedIds = expectedPublicSampleIds(selection);
		if (ids.size !== expectedIds.length || expectedIds.some((sampleId) => !ids.has(sampleId))) {
			errors.push('prepared.samples must exactly match the committed 66-sample selection');
		}
	}
	return { prepared, errors };
}

function descriptorContents(descriptor, size, label, maximumBytes) {
	if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
		throw new Error(`${label} exceeds its ${maximumBytes}-byte read budget`);
	}
	const contents = Buffer.allocUnsafe(size);
	let offset = 0;
	while (offset < size) {
		const bytesRead = fs.readSync(descriptor, contents, offset, size - offset, offset);
		if (bytesRead === 0) throw new Error(`${label} ended while being read`);
		offset += bytesRead;
	}
	return contents;
}

function wavDurationDescriptor(descriptor, fileSize) {
	const header = descriptorContents(descriptor, Math.min(fileSize, 12), 'WAV header', 12);
	if (header.length !== 12) throw new Error('WAV header is truncated');
	if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error('audio must be a RIFF/WAVE file');
	}
	let offset = 12;
	let byteRate = null;
	let dataBytes = null;
	const chunkHeader = Buffer.alloc(8);
	while (offset + chunkHeader.length <= fileSize) {
		if (
			fs.readSync(descriptor, chunkHeader, 0, chunkHeader.length, offset) !== chunkHeader.length
		) {
			break;
		}
		const chunkId = chunkHeader.toString('ascii', 0, 4);
		const chunkSize = chunkHeader.readUInt32LE(4);
		const chunkStart = offset + chunkHeader.length;
		if (chunkStart + chunkSize > fileSize) throw new Error(`WAV ${chunkId} chunk is truncated`);
		if (chunkId === 'fmt ') {
			if (chunkSize < 16) throw new Error('WAV fmt chunk is invalid');
			const format = Buffer.alloc(16);
			fs.readSync(descriptor, format, 0, format.length, chunkStart);
			byteRate = format.readUInt32LE(8);
			if (byteRate === 0) throw new Error('WAV byte rate must be positive');
		} else if (chunkId === 'data') {
			dataBytes = chunkSize;
		}
		if (byteRate !== null && dataBytes !== null) return dataBytes / byteRate;
		offset = chunkStart + chunkSize + (chunkSize % 2);
	}
	throw new Error('WAV must contain valid fmt and data chunks');
}

function snapshotOpenedSample(workspace, sample) {
	const audioPath = resolveInside(workspace, sample.audio_path, `sample '${sample.id}' audio`);
	const referencePath = resolveInside(
		workspace,
		sample.reference_path,
		`sample '${sample.id}' reference`,
	);
	const audioOpened = openExistingStableFile(audioPath, `sample '${sample.id}' audio`);
	let referenceOpened;
	try {
		referenceOpened = openExistingStableFile(referencePath, `sample '${sample.id}' reference`);
		const audioStatus = attestStableFile(audioOpened);
		const referenceStatus = attestStableFile(referenceOpened);
		const audioSize = Number(audioStatus.size);
		const referenceSize = Number(referenceStatus.size);
		const audioSha256 = sha256Descriptor(audioOpened.descriptor, audioSize);
		const referenceBytes = descriptorContents(
			referenceOpened.descriptor,
			referenceSize,
			`sample '${sample.id}' reference`,
			16 * 1024 * 1024,
		);
		let referenceText;
		try {
			referenceText = new TextDecoder('utf-8', { fatal: true }).decode(referenceBytes);
		} catch {
			throw new Error(`sample '${sample.id}' reference must be valid UTF-8`);
		}
		if (referenceText.trim().length === 0) {
			const explanation = sample.requires_manual_reference
				? 'the upstream transcript has no excerpt timestamps, so transcribe the excerpt by listening first'
				: 'complete the two-pass reference transcription first';
			throw new Error(`sample '${sample.id}' reference is empty; ${explanation}`);
		}
		const durationSeconds = wavDurationDescriptor(audioOpened.descriptor, audioSize);
		attestStableFile(audioOpened, { requireUnchangedContents: true });
		attestStableFile(referenceOpened, { requireUnchangedContents: true });
		if (audioSha256 !== sample.audio_sha256) {
			throw new Error(`sample '${sample.id}' audio_sha256 does not match the prepared audio`);
		}
		if (
			typeof sample.duration_seconds !== 'number' ||
			Math.abs(durationSeconds - sample.duration_seconds) > 0.001
		) {
			throw new Error(
				`sample '${sample.id}' duration_seconds does not match the recomputed WAV duration`,
			);
		}
		return {
			sample,
			audio: { opened: audioOpened, path: audioPath, sha256: audioSha256, durationSeconds },
			reference: {
				opened: referenceOpened,
				path: referencePath,
				text: referenceText,
				sha256: createHash('sha256').update(referenceBytes).digest('hex'),
			},
		};
	} catch (error) {
		fs.closeSync(audioOpened.descriptor);
		if (referenceOpened) fs.closeSync(referenceOpened.descriptor);
		throw error;
	}
}

function openSampleSnapshots(workspace, samples) {
	const snapshots = new Map();
	try {
		for (const sample of samples) snapshots.set(sample.id, snapshotOpenedSample(workspace, sample));
		return snapshots;
	} catch (error) {
		closeSampleSnapshots(snapshots);
		throw error;
	}
}

function reattestSampleSnapshots(snapshots) {
	for (const snapshot of snapshots.values()) {
		for (const file of [snapshot.audio, snapshot.reference]) {
			const status = attestStableFile(file.opened, { requireUnchangedContents: true });
			if (sha256Descriptor(file.opened.descriptor, Number(status.size)) !== file.sha256) {
				throw new Error(`${file.opened.label} bytes changed during the operation`);
			}
		}
	}
}

function closeSampleSnapshots(snapshots) {
	for (const snapshot of snapshots.values()) {
		fs.closeSync(snapshot.audio.opened.descriptor);
		fs.closeSync(snapshot.reference.opened.descriptor);
	}
}

export function validateReviewAttestations(document, preparedSamples, workspace, snapshots) {
	let ownedSnapshots;
	if (!snapshots) {
		try {
			ownedSnapshots = openSampleSnapshots(workspace, preparedSamples);
			snapshots = ownedSnapshots;
		} catch (error) {
			return [error.message];
		}
	}
	const errors = [];
	if (!isObject(document)) {
		if (ownedSnapshots) closeSampleSnapshots(ownedSnapshots);
		return ['review attestations must be an object'];
	}
	rejectUnknownFields(
		document,
		new Set(['schema_version', 'reference_protocol_id', 'samples']),
		'reviews',
		errors,
	);
	if (document.schema_version !== PUBLIC_REVIEW_SCHEMA_VERSION) {
		errors.push(`reviews.schema_version must be ${PUBLIC_REVIEW_SCHEMA_VERSION}`);
	}
	if (document.reference_protocol_id !== REFERENCE_PROTOCOL_ID) {
		errors.push(`reviews.reference_protocol_id must be '${REFERENCE_PROTOCOL_ID}'`);
	}
	if (!Array.isArray(document.samples)) {
		errors.push('reviews.samples must be an array');
		if (ownedSnapshots) closeSampleSnapshots(ownedSnapshots);
		return errors;
	}
	const reviewsById = new Map();
	for (const [index, review] of document.samples.entries()) {
		const prefix = `reviews.samples[${index}]`;
		if (!isObject(review)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		rejectUnknownFields(review, new Set(['sample_id', 'reviewers']), prefix, errors);
		if (reviewsById.has(review.sample_id)) errors.push(`${prefix}.sample_id is duplicated`);
		reviewsById.set(review.sample_id, review);
	}
	const expectedIds = new Set(preparedSamples.map((sample) => sample.id));
	for (const sampleId of reviewsById.keys()) {
		if (!expectedIds.has(sampleId)) errors.push(`reviews contains unknown sample '${sampleId}'`);
	}
	for (const sample of preparedSamples) {
		const review = reviewsById.get(sample.id);
		if (!review) {
			errors.push(`sample '${sample.id}' is missing review attestations`);
			continue;
		}
		if (!Array.isArray(review.reviewers) || review.reviewers.length < 2) {
			errors.push(`sample '${sample.id}' requires two independent accepted reviews`);
			continue;
		}
		const snapshot = snapshots.get(sample.id);
		if (!snapshot) {
			errors.push(`sample '${sample.id}' has no stable file snapshot`);
			continue;
		}
		const currentReferenceHash = snapshot.reference.sha256;
		const currentAudioHash = snapshot.audio.sha256;
		const reviewerIds = new Set();
		for (const [index, reviewer] of review.reviewers.entries()) {
			const prefix = `sample '${sample.id}' reviewer[${index}]`;
			if (!isObject(reviewer)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			rejectUnknownFields(
				reviewer,
				new Set([
					'reviewer_id',
					'reviewed_at',
					'decision',
					'affirmed_reference_protocol_id',
					'audio_sha256',
					'reference_sha256',
				]),
				prefix,
				errors,
			);
			if (!/^[a-z0-9][a-z0-9._-]*$/.test(reviewer.reviewer_id ?? '')) {
				errors.push(`${prefix}.reviewer_id must be an opaque lowercase identifier`);
			}
			if (reviewerIds.has(reviewer.reviewer_id)) {
				errors.push(`sample '${sample.id}' reviews must use distinct reviewer IDs`);
			}
			reviewerIds.add(reviewer.reviewer_id);
			if (
				typeof reviewer.reviewed_at !== 'string' ||
				!Number.isFinite(Date.parse(reviewer.reviewed_at))
			) {
				errors.push(`${prefix}.reviewed_at must be an ISO-8601 timestamp`);
			}
			if (reviewer.decision !== 'accepted') errors.push(`${prefix}.decision must be accepted`);
			if (reviewer.affirmed_reference_protocol_id !== REFERENCE_PROTOCOL_ID) {
				errors.push(`${prefix}.affirmed_reference_protocol_id must be '${REFERENCE_PROTOCOL_ID}'`);
			}
			if (reviewer.reference_sha256 !== currentReferenceHash) {
				errors.push(`${prefix}.reference_sha256 does not match the current reference`);
			}
			if (reviewer.audio_sha256 !== currentAudioHash) {
				errors.push(`${prefix}.audio_sha256 does not match the reviewed prepared audio`);
			}
		}
	}
	if (ownedSnapshots) closeSampleSnapshots(ownedSnapshots);
	return errors;
}

export function recordPublicReviewAttestation(options) {
	if (options.affirmReferenceProtocol !== REFERENCE_PROTOCOL_ID) {
		throw new Error(`review requires --affirm-reference-protocol ${REFERENCE_PROTOCOL_ID}`);
	}
	if (options.acceptReviewedReference !== true) {
		throw new Error(
			'review requires --accept-reviewed-reference after listening and reconciliation',
		);
	}
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(options.reviewerId ?? '')) {
		throw new Error('reviewer ID must be an opaque lowercase identifier');
	}
	if (!SLUG_PATTERN.test(options.sampleId ?? ''))
		throw new Error('sample ID must be a lowercase slug');
	const workspace = ensurePrivateDirectory(options.workspace, 'public corpus workspace');
	const lock = acquirePublicCorpusLock(workspace);
	let snapshots;
	try {
		const { catalog, selection } = loadPublicCorpusConfig(
			options.catalogPath,
			options.selectionPath,
		);
		const { prepared, errors: preparedErrors } = loadPreparedDocument(
			workspace,
			options.catalogPath,
			options.selectionPath,
			catalog,
			selection,
		);
		if (preparedErrors.length > 0) {
			throw new Error(`invalid prepared public corpus:\n- ${preparedErrors.join('\n- ')}`);
		}
		const sample = prepared.samples.find((candidate) => candidate.id === options.sampleId);
		if (!sample) throw new Error(`prepared public corpus has no sample '${options.sampleId}'`);
		snapshots = openSampleSnapshots(workspace, [sample]);
		const snapshot = snapshots.get(sample.id);
		const audio = snapshot.audio;
		const reference = snapshot.reference;
		const reviewsPath = path.join(workspace, 'review-attestations.json');
		const reviews = readJsonFile(reviewsPath, 'public reference review attestations');
		if (
			reviews.schema_version !== PUBLIC_REVIEW_SCHEMA_VERSION ||
			reviews.reference_protocol_id !== REFERENCE_PROTOCOL_ID ||
			!Array.isArray(reviews.samples)
		) {
			throw new Error('review-attestations.json has an invalid envelope');
		}
		const preparedIds = new Set(prepared.samples.map((candidate) => candidate.id));
		const reviewIds = reviews.samples.map((candidate) => candidate?.sample_id);
		if (
			reviewIds.length !== preparedIds.size ||
			new Set(reviewIds).size !== reviewIds.length ||
			reviewIds.some((sampleId) => !preparedIds.has(sampleId))
		) {
			throw new Error('review-attestations.json does not exactly match the prepared sample set');
		}
		const matchingReviews = reviews.samples.filter(
			(candidate) => candidate.sample_id === sample.id,
		);
		const review = matchingReviews[0];
		if (matchingReviews.length !== 1 || !review || !Array.isArray(review.reviewers)) {
			throw new Error(`review-attestations.json has no reviewer list for '${sample.id}'`);
		}
		if (review.reviewers.length >= 2) {
			throw new Error(`sample '${sample.id}' already has the required two reviews`);
		}
		if (review.reviewers.some((candidate) => candidate.reviewer_id === options.reviewerId)) {
			throw new Error(`reviewer '${options.reviewerId}' already attested sample '${sample.id}'`);
		}
		const reviewedAt = options.reviewedAt ?? new Date().toISOString();
		if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error('reviewed_at must be ISO-8601');
		review.reviewers.push({
			reviewer_id: options.reviewerId,
			reviewed_at: reviewedAt,
			decision: 'accepted',
			affirmed_reference_protocol_id: REFERENCE_PROTOCOL_ID,
			audio_sha256: audio.sha256,
			reference_sha256: reference.sha256,
		});
		assertPublicCorpusLockOwned(lock);
		atomicWriteJson(reviewsPath, reviews);
		reattestSampleSnapshots(snapshots);
		return {
			sampleId: sample.id,
			reviewerId: options.reviewerId,
			reviewCount: review.reviewers.length,
			audioSha256: audio.sha256,
			referenceSha256: reference.sha256,
		};
	} finally {
		if (snapshots) closeSampleSnapshots(snapshots);
		releasePublicCorpusLock(lock);
	}
}

function buildManifestSample(sample, snapshots) {
	const snapshot = snapshots.get(sample.id);
	if (!snapshot) throw new Error(`sample '${sample.id}' has no stable file snapshot`);
	const { audio, reference } = snapshot;
	return {
		id: sample.id,
		...(sample.session_id ? { session_id: sample.session_id } : {}),
		audio_path: sample.audio_path,
		audio_sha256: audio.sha256,
		reference_path: sample.reference_path,
		reference_sha256: reference.sha256,
		dataset: sample.dataset,
		language: sample.language,
		whisper_language: sample.whisper_language,
		scenario: sample.scenario,
		noise_condition: sample.noise_condition,
		speakers: sample.speakers,
		duration_seconds: audio.durationSeconds,
		provenance: sample.provenance,
	};
}

function canonicalJsonValue(value) {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalJsonValue(value[key])]),
	);
}

function buildPublicManifest(catalogPath, selection, prepared, snapshots) {
	return {
		schema_version: CORPUS_SCHEMA_VERSION,
		corpus_id: selection.corpus_id,
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		description:
			'Reproducible local-only public ASR corpus from pinned FLEURS, AMI, and Earnings-21 sources.',
		distribution: 'local',
		source_catalog_sha256: fileSha256(catalogPath),
		preparation: {
			protocol_id: PUBLIC_PREPARATION_PROTOCOL_ID,
			source_catalog_id: prepared.source_catalog_id,
			selection_sha256: prepared.selection_sha256,
			ffmpeg_id: prepared.ffmpeg.id,
			ffmpeg_sha256: prepared.ffmpeg.sha256,
			ffmpeg_version: prepared.ffmpeg.version,
		},
		samples: prepared.samples.map((sample) => buildManifestSample(sample, snapshots)),
	};
}

export async function finalizePublicCorpus(options, dependencies = {}) {
	if (options.affirmReferenceProtocol !== REFERENCE_PROTOCOL_ID) {
		throw new Error(`finalization requires --affirm-reference-protocol ${REFERENCE_PROTOCOL_ID}`);
	}
	const workspace = ensurePrivateDirectory(options.workspace, 'public corpus workspace');
	const lock = acquirePublicCorpusLock(workspace);
	let snapshots;
	try {
		const rebuildPreparedOutputs =
			dependencies.rebuildPreparedOutputs ??
			(async (rebuildOptions) => {
				const { preparePublicCorpusUnlocked } = await import('./public-corpus-prepare.ts');
				return preparePublicCorpusUnlocked({
					...rebuildOptions,
					allowNetwork: false,
					lock,
				});
			});
		await rebuildPreparedOutputs({
			workspace,
			catalogPath: options.catalogPath,
			selectionPath: options.selectionPath,
			...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
		});
		const { catalog, selection } = loadPublicCorpusConfig(
			options.catalogPath,
			options.selectionPath,
		);
		const { prepared, errors: preparedErrors } = loadPreparedDocument(
			workspace,
			options.catalogPath,
			options.selectionPath,
			catalog,
			selection,
		);
		if (preparedErrors.length > 0) {
			throw new Error(`invalid prepared public corpus:\n- ${preparedErrors.join('\n- ')}`);
		}
		snapshots = openSampleSnapshots(workspace, prepared.samples);
		const reviews = readJsonFile(
			path.join(workspace, 'review-attestations.json'),
			'public reference review attestations',
		);
		const reviewErrors = validateReviewAttestations(
			reviews,
			prepared.samples,
			workspace,
			snapshots,
		);
		if (reviewErrors.length > 0) {
			throw new Error(`public reference review is incomplete:\n- ${reviewErrors.join('\n- ')}`);
		}
		const manifestPath = path.join(workspace, 'corpus-local.json');
		const manifest = buildPublicManifest(options.catalogPath, selection, prepared, snapshots);
		const manifestErrors = validateCorpusDocument(manifest, {
			manifestPath,
			checkFiles: false,
			enforceLocalParticipantCustody: false,
		});
		if (manifestErrors.length > 0) {
			throw new Error(
				`generated public corpus manifest is invalid:\n- ${manifestErrors.join('\n- ')}`,
			);
		}
		dependencies.beforeManifestPublish?.({ manifestPath, manifest });
		assertPublicCorpusLockOwned(lock);
		reattestSampleSnapshots(snapshots);
		publishJsonNoClobber(manifestPath, manifest);
		reattestSampleSnapshots(snapshots);
		return { manifestPath, sampleCount: manifest.samples.length, manifest };
	} finally {
		if (snapshots) closeSampleSnapshots(snapshots);
		releasePublicCorpusLock(lock);
	}
}

export function validateFinalizedPublicCorpus(options) {
	const errors = [];
	let config;
	try {
		config = loadPublicCorpusConfig(options.catalogPath, options.selectionPath);
	} catch (error) {
		return [error.message];
	}
	const workspace = path.resolve(options.workspace);
	let prepared;
	let snapshots;
	try {
		const loaded = loadPreparedDocument(
			workspace,
			options.catalogPath,
			options.selectionPath,
			config.catalog,
			config.selection,
		);
		prepared = loaded.prepared;
		errors.push(...loaded.errors);
		if (loaded.errors.length === 0)
			snapshots = openSampleSnapshots(workspace, prepared.samples ?? []);
	} catch (error) {
		errors.push(error.message);
		return errors;
	}
	try {
		const reviews = readJsonFile(
			path.join(workspace, 'review-attestations.json'),
			'public reference review attestations',
		);
		errors.push(
			...validateReviewAttestations(reviews, prepared.samples ?? [], workspace, snapshots),
		);
	} catch (error) {
		errors.push(error.message);
	}
	const manifestPath = path.join(workspace, 'corpus-local.json');
	try {
		const manifest = readJsonFile(manifestPath, 'public corpus manifest');
		errors.push(
			...validateCorpusDocument(manifest, {
				manifestPath,
				checkFiles: true,
				enforceLocalParticipantCustody: false,
			}),
		);
		const expectedManifest = buildPublicManifest(
			options.catalogPath,
			config.selection,
			prepared,
			snapshots,
		);
		if (
			JSON.stringify(canonicalJsonValue(manifest)) !==
			JSON.stringify(canonicalJsonValue(expectedManifest))
		) {
			errors.push(
				'manifest does not exactly match the reviewed prepared metadata and recomputed files',
			);
		}
	} catch (error) {
		errors.push(error.message);
	} finally {
		if (snapshots) closeSampleSnapshots(snapshots);
	}
	return [...new Set(errors)];
}

export function sha256Text(value) {
	return createHash('sha256').update(value).digest('hex');
}
