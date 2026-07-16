#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateCoverageTargets } from './coverage.ts';
import { canonicalFilePath, canonicalManifestPath, loadCorpus } from './corpus.ts';
import { TARGET_LANGUAGES, TARGET_NOISE_CONDITIONS } from './corpus-intake.ts';
import { processIdentity, processOwnsState } from './process-identity.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repositoryIntakeRoot = path.join(repositoryRoot, 'app/scripts/eval');

function primaryLanguage(language) {
	return language.split('-')[0].toLowerCase();
}

function collectionSessions(samples) {
	const sessionsByCell = new Map();
	for (const sample of samples) {
		if (
			sample.scenario !== 'meeting' ||
			sample.provenance?.basis !== 'participant-consent' ||
			typeof sample.session_id !== 'string'
		) {
			continue;
		}
		const key = `${primaryLanguage(sample.language)} / ${sample.noise_condition}`;
		if (!sessionsByCell.has(key)) sessionsByCell.set(key, new Set());
		sessionsByCell.get(key).add(sample.session_id);
	}
	return sessionsByCell;
}

function pendingCollectionSessions(intakeRoot) {
	const sessions = [];
	const rootEntry = fs.lstatSync(intakeRoot, { throwIfNoEntry: false });
	if (!rootEntry) return sessions;
	if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
		throw new Error(`intake directory must be a regular directory: ${intakeRoot}`);
	}
	for (const entry of fs.readdirSync(intakeRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const metadataPath = path.join(intakeRoot, entry.name, 'collection-session.json');
		const metadataEntry = fs.lstatSync(metadataPath, { throwIfNoEntry: false });
		if (!metadataEntry) continue;
		if (!metadataEntry.isFile() || metadataEntry.isSymbolicLink()) {
			throw new Error(`collection session metadata must be a regular file: ${metadataPath}`);
		}
		let metadata;
		try {
			metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
		} catch (error) {
			throw new Error(
				`failed to read collection session metadata ${metadataPath}: ${error.message}`,
			);
		}
		if (
			metadata.schemaVersion !== 1 ||
			typeof metadata.sessionId !== 'string' ||
			typeof metadata.language !== 'string' ||
			typeof metadata.noiseCondition !== 'string'
		) {
			throw new Error(`collection session metadata is invalid: ${metadataPath}`);
		}
		sessions.push(metadata);
	}
	return sessions;
}

function validatePreparationTargets(targets) {
	const targetErrors = validateCoverageTargets(targets);
	for (const language of targets.languages ?? []) {
		if (!TARGET_LANGUAGES.has(language)) {
			targetErrors.push(`targets.languages contains unsupported intake language '${language}'`);
		}
	}
	for (const noiseCondition of targets.noise_conditions ?? []) {
		if (!TARGET_NOISE_CONDITIONS.has(noiseCondition)) {
			targetErrors.push(
				`targets.noise_conditions contains unsupported intake condition '${noiseCondition}'`,
			);
		}
	}
	if (targetErrors.length > 0) {
		throw new Error(`invalid coverage targets:\n- ${targetErrors.join('\n- ')}`);
	}
}

export function planCollectionCells(corpus, targets, pendingSessions = []) {
	validatePreparationTargets(targets);
	const sessionsByCell = collectionSessions(corpus.samples);
	const pendingByCell = new Map();
	for (const session of pendingSessions) {
		const key = `${primaryLanguage(session.language)} / ${session.noiseCondition}`;
		if (!pendingByCell.has(key)) pendingByCell.set(key, new Set());
		if (!sessionsByCell.get(key)?.has(session.sessionId)) {
			pendingByCell.get(key).add(session.sessionId);
		}
	}
	const cells = [];
	let order = 0;
	for (const language of targets.languages) {
		for (const noiseCondition of targets.noise_conditions) {
			const key = `${language} / ${noiseCondition}`;
			const collected = sessionsByCell.get(key)?.size ?? 0;
			const prepared = pendingByCell.get(key)?.size ?? 0;
			cells.push({
				language,
				noiseCondition,
				collected,
				prepared,
				required: targets.min_sessions_per_language_noise_cell,
				missing: Math.max(0, targets.min_sessions_per_language_noise_cell - collected - prepared),
				order,
			});
			order += 1;
		}
	}
	return cells
		.filter((cell) => cell.missing > 0)
		.sort(
			(left, right) =>
				left.collected + left.prepared - (right.collected + right.prepared) ||
				left.order - right.order,
		);
}

function assertPrivateDirectory(directory, label) {
	const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
	if (entry?.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${directory}`);
	if (entry && !entry.isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
}

function readPreparationLockOwner(lockPath) {
	const lockEntry = fs.lstatSync(lockPath);
	if (!lockEntry.isDirectory() || lockEntry.isSymbolicLink()) {
		throw new Error(`collection preparation lock must be a regular directory: ${lockPath}`);
	}
	const ownerPath = path.join(lockPath, 'owner.json');
	const ownerEntry = fs.lstatSync(ownerPath);
	if (!ownerEntry.isFile() || ownerEntry.isSymbolicLink()) {
		throw new Error(`collection preparation lock owner must be a regular file: ${ownerPath}`);
	}
	const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
	if (
		!Number.isInteger(owner.pid) ||
		owner.pid < 1 ||
		typeof owner.token !== 'string' ||
		!/^[0-9a-f-]{36}$/.test(owner.token)
	) {
		throw new Error(`collection preparation lock owner is invalid: ${ownerPath}`);
	}
	return owner;
}

function waitForPreparationLock(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function isPreparationLockContention(errorCode, lockExists) {
	return (
		lockExists || ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(errorCode)
	);
}

function acquirePreparationLock(intakeRoot, timeoutMs = 30_000) {
	const lockPath = path.join(intakeRoot, '.prepare.lock');
	const token = randomUUID();
	const pendingPath = `${lockPath}.pending-${token}`;
	const identity = processIdentity(process.pid);
	fs.mkdirSync(pendingPath, { mode: 0o700 });
	try {
		writePrivateFile(
			path.join(pendingPath, 'owner.json'),
			`${JSON.stringify({
				schema_version: 1,
				pid: process.pid,
				...(identity ? { process_identity: identity } : {}),
				token,
				created_at: new Date().toISOString(),
			})}\n`,
		);
		const deadline = Date.now() + timeoutMs;
		let vanishedLockRetries = 0;
		for (;;) {
			if (Date.now() >= deadline) {
				throw new Error(`timed out waiting for another collection preparation: ${lockPath}`);
			}
			try {
				fs.renameSync(pendingPath, lockPath);
				return { lockPath, token };
			} catch (error) {
				const lockExists = fs.existsSync(lockPath);
				if (!isPreparationLockContention(error.code, lockExists)) throw error;
				if (!lockExists) {
					vanishedLockRetries += 1;
					if (vanishedLockRetries > 10) throw error;
					waitForPreparationLock(Math.min(25, Math.max(1, deadline - Date.now())));
					continue;
				}
			}
			vanishedLockRetries = 0;

			let owner;
			try {
				owner = readPreparationLockOwner(lockPath);
			} catch (error) {
				if (!fs.existsSync(lockPath)) continue;
				throw new Error(
					`another collection preparation is active or left an unreadable lock: ${lockPath}; ${error.message}`,
				);
			}
			if (processOwnsState(owner)) {
				waitForPreparationLock(Math.min(25, Math.max(1, deadline - Date.now())));
				continue;
			}
			const stalePath = `${lockPath}.stale-${owner.token}`;
			try {
				fs.renameSync(lockPath, stalePath);
				fs.rmSync(stalePath, { recursive: true, force: true });
			} catch (error) {
				if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(error.code)) continue;
				throw error;
			}
		}
	} catch (error) {
		fs.rmSync(pendingPath, { recursive: true, force: true });
		throw error;
	}
}

function releasePreparationLock(lockPath, token) {
	try {
		const owner = readPreparationLockOwner(lockPath);
		if (owner.pid !== process.pid || owner.token !== token) return;
	} catch {
		return;
	}
	fs.rmSync(lockPath, { recursive: true, force: true });
}

function withPreparationLock(intakeRoot, timeoutMs, callback) {
	const { lockPath, token } = acquirePreparationLock(intakeRoot, timeoutMs);
	try {
		return callback();
	} finally {
		releasePreparationLock(lockPath, token);
	}
}

function isWithinOrEqual(directory, candidate) {
	const relative = path.relative(directory, candidate);
	return (
		relative === '' ||
		(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

function writePrivateFile(filePath, contents) {
	fs.writeFileSync(filePath, contents, { flag: 'wx', mode: 0o600 });
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function renderConsentRecord(template, session) {
	const rendered = template
		.replace(
			'- Consent record ID: `consent-...` (the only value copied into the corpus manifest)',
			`- Consent record ID: \`${session.consentRecordId}\` (the only value copied into the corpus manifest)`,
		)
		.replace(
			'- Meeting/session ID: `session-...` (opaque; no title, customer, or participant names)',
			`- Meeting/session ID: \`${session.sessionId}\` (opaque; no title, customer, or participant names)`,
		)
		.replace('- Languages:', `- Languages: ${session.language}`)
		.replace(
			'- Benchmark condition: `clean` / `office` / `remote-call` / `overlapping-speech`',
			`- Benchmark condition: \`${session.noiseCondition}\``,
		);
	if (
		!rendered.includes(`- Consent record ID: \`${session.consentRecordId}\``) ||
		!rendered.includes(`- Meeting/session ID: \`${session.sessionId}\``) ||
		!rendered.includes(`- Languages: ${session.language}`) ||
		!rendered.includes(`- Benchmark condition: \`${session.noiseCondition}\``)
	) {
		throw new Error('consent record template is missing required collection placeholders');
	}
	return rendered;
}

function renderSessionReadme(session) {
	const command = [
		`nub ${shellQuote(session.intakeScriptPath)}`,
		`  --manifest ${shellQuote(session.manifestPath)}`,
		`  --audio ${shellQuote(session.audioPath)}`,
		`  --reference ${shellQuote(session.referencePath)}`,
		`  --sample-id ${shellQuote(session.sampleId)}`,
		`  --session-id ${shellQuote(session.sessionId)}`,
		`  --consent-record-id ${shellQuote(session.consentRecordId)}`,
		`  --consent-record ${shellQuote(session.consentRecordPath)}`,
		"  --consent-date 'YYYY-MM-DD'",
		`  --language ${shellQuote(session.language)}`,
		`  --noise-condition ${shellQuote(session.noiseCondition)}`,
		"  --speakers '<count>'",
		'  --affirm-all-participants-consented',
	].join(' \\\n');
	return `# Private ASR collection session

Target: \`${session.language} / ${session.noiseCondition}\`

1. Complete the separate consent record before recording.
2. Save the matching RIFF/WAVE recording as \`recording.wav\` in this directory.
3. Write a verbatim UTF-8 transcript in \`reference.txt\`.
4. Replace the consent date and speaker count below, then run:

\`\`\`bash
${command}
\`\`\`

Preparing this bundle does not establish consent and does not add anything to the corpus.
`;
}

function chooseCell(cells, options) {
	if (options.language === undefined && options.noiseCondition === undefined) return cells[0];
	if (!options.language || !options.noiseCondition) {
		throw new Error('--language and --noise-condition must be provided together');
	}
	const cell = cells.find(
		(candidate) =>
			candidate.language === options.language &&
			candidate.noiseCondition === options.noiseCondition,
	);
	if (!cell) {
		throw new Error(
			`requested collection cell is already complete or not targeted: ${options.language} / ${options.noiseCondition}`,
		);
	}
	return cell;
}

export function prepareCollectionSession(options) {
	const manifestPath = canonicalManifestPath(options.manifestPath, { allowMissing: true });
	if (!options.consentRecordsDir) {
		throw new Error('--consent-records-dir or MUESLY_CORPUS_CONSENT_RECORDS_DIR is required');
	}
	const targets = JSON.parse(fs.readFileSync(path.resolve(options.targetsPath), 'utf8'));
	const corpus = fs.existsSync(manifestPath)
		? loadCorpus(manifestPath)
		: { corpus_id: 'consented-meetings-v1', distribution: 'local', samples: [] };
	if (corpus.distribution !== 'local') {
		throw new Error('collection preparation requires a local corpus manifest');
	}
	validatePreparationTargets(targets);
	const root = path.dirname(manifestPath);
	const intakeRoot = path.join(root, 'intake');
	const consentRoot = canonicalFilePath(options.consentRecordsDir, { allowMissing: true });
	const protectedRepositoryRoot = canonicalFilePath(options.repositoryRoot ?? repositoryRoot);
	const allowedRepositoryIntakeRoot = canonicalFilePath(
		options.repositoryIntakeRoot ?? repositoryIntakeRoot,
		{ allowMissing: true },
	);
	const allowedRepositoryManifestPath = path.join(
		allowedRepositoryIntakeRoot,
		'corpus-local.json',
	);
	if (
		isWithinOrEqual(protectedRepositoryRoot, manifestPath) &&
		manifestPath !== allowedRepositoryManifestPath
	) {
		throw new Error(
			`repository-local collection requires the ignored manifest: ${allowedRepositoryManifestPath}`,
		);
	}
	if (isWithinOrEqual(protectedRepositoryRoot, consentRoot)) {
		throw new Error('consent records directory must be outside the Git repository');
	}
	assertPrivateDirectory(intakeRoot, 'intake directory');
	assertPrivateDirectory(consentRoot, 'consent records directory');
	return withPreparationLock(intakeRoot, options.lockTimeoutMs, () => {
		const cells = planCollectionCells(corpus, targets, pendingCollectionSessions(intakeRoot));
		if (cells.length === 0) {
			throw new Error('all required session observations are collected or already prepared');
		}
		const cell = chooseCell(cells, options);
		const id = (options.idFactory ?? randomUUID)();
		if (!/^[0-9a-f-]{36}$/.test(id)) {
			throw new Error('session ID generator returned an invalid UUID');
		}
		const sessionId = `session-${id}`;
		const consentRecordId = `consent-${id}`;
		const sampleId = `${cell.language}-${cell.noiseCondition}-${id}`;
		const sessionDirectory = path.join(intakeRoot, sessionId);
		const consentRecordPath = path.join(consentRoot, `${consentRecordId}.md`);
		if (fs.lstatSync(sessionDirectory, { throwIfNoEntry: false })) {
			throw new Error(`collection session already exists: ${sessionDirectory}`);
		}
		if (fs.lstatSync(consentRecordPath, { throwIfNoEntry: false })) {
			throw new Error(`consent record already exists: ${consentRecordPath}`);
		}
		fs.mkdirSync(sessionDirectory, { mode: 0o700 });
		const referencePath = path.join(sessionDirectory, 'reference.txt');
		const audioPath = path.join(sessionDirectory, 'recording.wav');
		const metadataPath = path.join(sessionDirectory, 'collection-session.json');
		const readmePath = path.join(sessionDirectory, 'README.md');
		const session = {
			schemaVersion: 1,
			sessionId,
			consentRecordId,
			sampleId,
			language: cell.language,
			noiseCondition: cell.noiseCondition,
			manifestPath,
			audioPath,
			referencePath,
			consentRecordPath,
			intakeScriptPath:
				options.intakeScriptPath ??
				fileURLToPath(new URL('./corpus-intake.ts', import.meta.url)),
			collectedSessionsInCell: cell.collected,
			preparedSessionsInCell: cell.prepared,
			requiredSessionsInCell: cell.required,
			remainingUnpreparedObservations:
				cells.reduce((total, candidate) => total + candidate.missing, 0) - 1,
		};
		let createdConsentRecord = false;
		try {
			const templatePath =
				options.templatePath ??
				fileURLToPath(new URL('./consent-record.example.md', import.meta.url));
			const template = fs.readFileSync(templatePath, 'utf8');
			writePrivateFile(consentRecordPath, renderConsentRecord(template, session));
			createdConsentRecord = true;
			writePrivateFile(referencePath, '');
			writePrivateFile(metadataPath, `${JSON.stringify(session, null, 2)}\n`);
			writePrivateFile(readmePath, renderSessionReadme(session));
			return session;
		} catch (error) {
			fs.rmSync(sessionDirectory, { recursive: true, force: true });
			if (createdConsentRecord) fs.rmSync(consentRecordPath, { force: true });
			throw error;
		}
	});
}

function requiredValue(args, index, option) {
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
	return value;
}

export function parsePrepareArgs(args, defaults) {
	const options = { ...defaults };
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		const fields = {
			'--manifest': 'manifestPath',
			'--targets': 'targetsPath',
			'--consent-records-dir': 'consentRecordsDir',
			'--language': 'language',
			'--noise-condition': 'noiseCondition',
		};
		const field = fields[option];
		if (!field) throw new Error(`unknown option: ${option}`);
		options[field] = requiredValue(args, index, option);
		index += 1;
	}
	return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const options = parsePrepareArgs(process.argv.slice(2), {
			manifestPath: path.join(here, 'corpus-local.json'),
			targetsPath: path.join(here, 'corpus-targets.json'),
			consentRecordsDir: process.env.MUESLY_CORPUS_CONSENT_RECORDS_DIR,
		});
		const session = prepareCollectionSession(options);
		console.log(`prepared ${session.sessionId}: ${session.language} / ${session.noiseCondition}`);
		console.log(`collection bundle: ${path.dirname(session.referencePath)}`);
		console.log(`consent record: ${session.consentRecordPath}`);
		console.log(
			`remaining unprepared session-cell observations: ${session.remainingUnpreparedObservations}`,
		);
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
}
