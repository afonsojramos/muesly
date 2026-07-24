-- Vectors for on-device semantic search. One row per transcript/summary chunk,
-- storing the L2-normalized f32-LE embedding as a BLOB (brute-force cosine at
-- personal scale needs no vector index). `model_id` scopes rows to the
-- embedding model that produced them, so a model upgrade invalidates by
-- mismatch. `excerpt` renders search snippets without re-joining transcripts;
-- `audio_start_time` preserves timestamp navigation for transcript chunks.
CREATE TABLE IF NOT EXISTS meeting_embeddings (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('transcript', 'summary')),
    chunk_index INTEGER NOT NULL,
    excerpt TEXT NOT NULL,
    audio_start_time REAL,
    model_id TEXT NOT NULL,
    vector BLOB NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_embeddings_meeting
    ON meeting_embeddings(meeting_id, source);
CREATE INDEX IF NOT EXISTS idx_meeting_embeddings_model
    ON meeting_embeddings(model_id);
