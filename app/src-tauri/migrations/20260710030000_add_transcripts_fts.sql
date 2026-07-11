-- Full-text search for transcript bodies: a denormalized FTS table synced by
-- triggers. External-content FTS5 (keyed on transcripts.rowid) would avoid
-- storing a second copy of each body, but needs the special 'delete' insert
-- syntax in the triggers; denormalized keeps them plain at the cost of storage.
CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
    id UNINDEXED,
    meeting_id UNINDEXED,
    transcript,
    timestamp UNINDEXED,
    tokenize = 'porter unicode61'
);

-- Backfill existing rows (the vtable is freshly created, so no dedup needed).
INSERT INTO transcripts_fts(id, meeting_id, transcript, timestamp)
SELECT id, meeting_id, transcript, timestamp FROM transcripts;

CREATE TRIGGER IF NOT EXISTS transcripts_fts_ai AFTER INSERT ON transcripts BEGIN
    INSERT INTO transcripts_fts(id, meeting_id, transcript, timestamp)
    VALUES (new.id, new.meeting_id, new.transcript, new.timestamp);
END;

CREATE TRIGGER IF NOT EXISTS transcripts_fts_ad AFTER DELETE ON transcripts BEGIN
    DELETE FROM transcripts_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS transcripts_fts_au AFTER UPDATE OF transcript, meeting_id, timestamp ON transcripts BEGIN
    DELETE FROM transcripts_fts WHERE id = old.id;
    INSERT INTO transcripts_fts(id, meeting_id, transcript, timestamp)
    VALUES (new.id, new.meeting_id, new.transcript, new.timestamp);
END;
