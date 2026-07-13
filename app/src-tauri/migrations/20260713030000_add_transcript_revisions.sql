CREATE TABLE transcript_revisions (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    model TEXT,
    language TEXT,
    character_count INTEGER NOT NULL,
    average_confidence REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE transcript_revision_segments (
    revision_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    transcript_id TEXT NOT NULL,
    transcript TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    summary TEXT,
    action_items TEXT,
    key_points TEXT,
    audio_start_time REAL,
    audio_end_time REAL,
    duration REAL,
    speaker TEXT,
    speaker_id INTEGER,
    PRIMARY KEY (revision_id, position),
    FOREIGN KEY (revision_id) REFERENCES transcript_revisions(id) ON DELETE CASCADE
);

CREATE INDEX idx_transcript_revisions_meeting_created
    ON transcript_revisions(meeting_id, created_at DESC);
