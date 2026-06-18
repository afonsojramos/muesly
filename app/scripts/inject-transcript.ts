#!/usr/bin/env node
/**
 * Meeting Transcript Database Injector
 *
 * Injects CSV-based transcript data into the muesly SQLite database, creating
 * meeting entries identical to those produced by a normal recording. Useful for
 * exercising the summary / multi-language / title-generation paths with canned
 * transcripts, without recording a real meeting.
 *
 * Uses only Node builtins (incl. `node:sqlite`, stable since Node 24), so it
 * runs the same way as the other scripts in this folder:
 *
 *   node scripts/inject-transcript.ts --csv transcript.csv --title "Test Meeting"
 *   node scripts/inject-transcript.ts --csv transcript.csv --db /path/to/db.sqlite
 *   pnpm inject-transcript --csv transcript.csv
 *
 * CSV format (minimal — only a `text` column is required; an optional `speaker`
 * column may hold `mic` or `system` to attribute each line):
 *   text,speaker
 *   "Hello everyone, let's start the meeting.",mic
 *   "First item on the agenda is the Q1 roadmap.",system
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

type Speaker = 'mic' | 'system';

interface RawSegment {
	text: string;
	speaker: Speaker;
}

interface ProcessedSegment extends RawSegment {
	id: string;
	timestamp: string;
	audioStartTime: number;
	audioEndTime: number;
	duration: number;
}

/** The DB filename the app uses (see `database/manager.rs`). */
const DB_FILENAME = 'meeting_minutes.sqlite';

/** Default database path, matching the app's per-platform app-data location. */
function getDefaultDbPath(): string {
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', 'muesly', DB_FILENAME);
	}
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
		return join(appData, 'muesly', DB_FILENAME);
	}
	return join(homedir(), '.config', 'muesly', DB_FILENAME);
}

/** Match the app's timestamp shape: RFC3339 with a `+00:00` offset (chrono). */
function toRfc3339(date: Date): string {
	return date.toISOString().replace('Z', '+00:00');
}

/** Estimate speech duration from word count (~150 wpm = ~0.4s/word, min 0.5s). */
function estimateDuration(text: string): number {
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	return Math.max(wordCount * 0.4, 0.5);
}

/**
 * Minimal RFC 4180 CSV parser: handles quoted fields, embedded commas/newlines,
 * and doubled-quote escapes. Returns rows of string cells.
 */
function parseCsv(content: string): string[][] {
	if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip BOM
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;

	for (let i = 0; i < content.length; i++) {
		const c = content[i];
		if (inQuotes) {
			if (c === '"') {
				if (content[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
			continue;
		}
		if (c === '"') {
			inQuotes = true;
		} else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\r') {
			// ignore; the paired \n ends the row
		} else if (c === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else {
			field += c;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function normalizeSpeaker(value: string | undefined, fallback: Speaker): Speaker {
	return value?.trim().toLowerCase() === 'system' ? 'system' : value?.trim() ? 'mic' : fallback;
}

/** Read transcript segments from a CSV file (requires a `text` column). */
function readCsv(csvPath: string, defaultSpeaker: Speaker): RawSegment[] {
	const rows = parseCsv(readFileSync(csvPath, 'utf8'));
	if (rows.length === 0) throw new Error('CSV file is empty');

	const header = rows[0].map((h) => h.trim().toLowerCase());
	const textIdx = header.indexOf('text');
	const speakerIdx = header.indexOf('speaker');
	if (textIdx === -1) throw new Error("CSV must have a 'text' column");

	const segments: RawSegment[] = [];
	for (const cells of rows.slice(1)) {
		const text = (cells[textIdx] ?? '').trim();
		if (!text) continue; // skip blank lines, matching the original behavior
		segments.push({
			text,
			speaker: normalizeSpeaker(speakerIdx === -1 ? undefined : cells[speakerIdx], defaultSpeaker)
		});
	}

	if (segments.length === 0) throw new Error('CSV file contains no transcript segments');
	return segments;
}

/** Add ids, sequential timestamps, and audio timing to raw segments. */
function processSegments(segments: RawSegment[], startTime: Date): ProcessedSegment[] {
	let audioTime = 0;
	let timestampMs = startTime.getTime();

	return segments.map((segment) => {
		const duration = estimateDuration(segment.text);
		const processed: ProcessedSegment = {
			...segment,
			id: `seg-${randomUUID()}`,
			timestamp: toRfc3339(new Date(timestampMs)),
			audioStartTime: audioTime,
			audioEndTime: audioTime + duration,
			duration
		};
		audioTime += duration;
		timestampMs += duration * 1000;
		return processed;
	});
}

/** Insert a meeting + its transcript segments in a single transaction. */
function injectMeeting(
	dbPath: string,
	title: string,
	segments: ProcessedSegment[],
	createdAt: Date,
	folderPath: string | null
): string {
	const meetingId = `meeting-${randomUUID()}`;
	const now = toRfc3339(createdAt);
	const db = new DatabaseSync(dbPath);

	try {
		db.exec('BEGIN TRANSACTION');

		db.prepare(
			'INSERT INTO meetings (id, title, created_at, updated_at, folder_path) VALUES (?, ?, ?, ?, ?)'
		).run(meetingId, title, now, now, folderPath);

		const insertSegment = db.prepare(
			`INSERT INTO transcripts
				(id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const seg of segments) {
			insertSegment.run(
				seg.id,
				meetingId,
				seg.text,
				seg.timestamp,
				seg.audioStartTime,
				seg.audioEndTime,
				seg.duration,
				seg.speaker
			);
		}

		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw new Error(`Database insertion failed: ${(error as Error).message}`);
	} finally {
		db.close();
	}

	return meetingId;
}

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function main(): void {
	const { values } = parseArgs({
		options: {
			csv: { type: 'string', short: 'c' },
			db: { type: 'string', short: 'd' },
			title: { type: 'string', short: 't' },
			'created-at': { type: 'string' },
			'folder-path': { type: 'string', short: 'f' },
			speaker: { type: 'string' },
			help: { type: 'boolean', short: 'h' }
		}
	});

	if (values.help || !values.csv) {
		console.log(
			[
				'Inject CSV transcript data into the muesly database.',
				'',
				'Usage: node scripts/inject-transcript.ts --csv <file> [options]',
				'',
				'Options:',
				'  -c, --csv <file>        CSV file with a `text` column (and optional `speaker`) [required]',
				'  -d, --db <path>         Database path (defaults to the platform app-data location)',
				'  -t, --title <title>     Meeting title (defaults to "Injected Meeting - <timestamp>")',
				'      --created-at <iso>  Meeting creation timestamp, ISO format (defaults to now)',
				'  -f, --folder-path <p>   Optional path to an audio folder',
				'      --speaker <who>     Default speaker when the CSV has no `speaker` column: mic|system (default mic)',
				'  -h, --help              Show this help'
			].join('\n')
		);
		process.exit(values.help ? 0 : 1);
	}

	const dbPath = values.db ?? getDefaultDbPath();
	if (!existsSync(dbPath)) {
		console.error(`Error: Database not found at ${dbPath}`);
		fail('Make sure muesly has been run at least once to create the database.');
	}

	if (!existsSync(values.csv)) fail(`CSV file not found at ${values.csv}`);

	let createdAt: Date;
	if (values['created-at']) {
		createdAt = new Date(values['created-at']);
		if (Number.isNaN(createdAt.getTime())) {
			fail(`Invalid timestamp format: ${values['created-at']} (use ISO, e.g. 2026-06-17T10:00:00Z)`);
		}
	} else {
		createdAt = new Date();
	}

	const defaultSpeaker: Speaker = values.speaker?.trim().toLowerCase() === 'system' ? 'system' : 'mic';
	const title =
		values.title ?? `Injected Meeting - ${toRfc3339(createdAt).slice(0, 16).replace('T', ' ')}`;

	console.log(`Reading CSV: ${values.csv}`);
	let segments: RawSegment[];
	try {
		segments = readCsv(values.csv, defaultSpeaker);
	} catch (error) {
		fail(`reading CSV: ${(error as Error).message}`);
	}

	console.log(`Processing ${segments.length} transcript segments...`);
	const processed = processSegments(segments, createdAt);

	console.log(`Injecting into database: ${dbPath}`);
	let meetingId: string;
	try {
		meetingId = injectMeeting(dbPath, title, processed, createdAt, values['folder-path'] ?? null);
	} catch (error) {
		fail(`injecting meeting: ${(error as Error).message}`);
	}

	const totalDuration = processed.reduce((max, s) => Math.max(max, s.audioEndTime), 0);
	console.log('\n' + '='.repeat(50));
	console.log('SUCCESS: Meeting injected');
	console.log('='.repeat(50));
	console.log(`  Meeting ID:      ${meetingId}`);
	console.log(`  Title:           ${title}`);
	console.log(`  Created At:      ${toRfc3339(createdAt)}`);
	console.log(`  Segments:        ${processed.length}`);
	console.log(`  Total Duration:  ${totalDuration.toFixed(1)} seconds`);
	if (values['folder-path']) console.log(`  Folder Path:     ${values['folder-path']}`);
	console.log('\nThe meeting should now appear in the muesly sidebar.');
}

main();
