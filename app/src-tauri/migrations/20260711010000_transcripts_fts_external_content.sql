-- Rebuild transcripts_fts as an external-content FTS5 table keyed on
-- transcripts.rowid, so transcript bodies are indexed without storing a second
-- full copy (relevant for hours-long meetings). meeting_id / timestamp are read
-- from transcripts at query time via a rowid join, so only the body is indexed.
-- External content does not auto-sync: triggers must mirror every change, and
-- delete/update use the FTS5 'delete' command with the OLD row's values.
DROP TRIGGER IF EXISTS transcripts_fts_ai;
DROP TRIGGER IF EXISTS transcripts_fts_ad;
DROP TRIGGER IF EXISTS transcripts_fts_au;
DROP TABLE IF EXISTS transcripts_fts;

CREATE VIRTUAL TABLE transcripts_fts USING fts5(
    transcript,
    content='transcripts',
    content_rowid='rowid',
    tokenize = 'porter unicode61'
);

INSERT INTO transcripts_fts(rowid, transcript)
SELECT rowid, transcript FROM transcripts;

CREATE TRIGGER transcripts_fts_ai AFTER INSERT ON transcripts BEGIN
    INSERT INTO transcripts_fts(rowid, transcript)
    VALUES (new.rowid, new.transcript);
END;

CREATE TRIGGER transcripts_fts_ad AFTER DELETE ON transcripts BEGIN
    INSERT INTO transcripts_fts(transcripts_fts, rowid, transcript)
    VALUES ('delete', old.rowid, old.transcript);
END;

CREATE TRIGGER transcripts_fts_au AFTER UPDATE OF transcript ON transcripts BEGIN
    INSERT INTO transcripts_fts(transcripts_fts, rowid, transcript)
    VALUES ('delete', old.rowid, old.transcript);
    INSERT INTO transcripts_fts(rowid, transcript)
    VALUES (new.rowid, new.transcript);
END;
