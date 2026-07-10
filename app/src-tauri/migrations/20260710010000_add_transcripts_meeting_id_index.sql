-- Speed meeting-scoped transcript queries (open, diarize, delete, pagination).
-- SQLite does not auto-index foreign keys.
CREATE INDEX IF NOT EXISTS idx_transcripts_meeting_id ON transcripts(meeting_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_meeting_start ON transcripts(meeting_id, audio_start_time);
