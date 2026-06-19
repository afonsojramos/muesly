-- Diarized speaker cluster index for a transcript segment, assigned by the
-- diarization sidecar after recording. NULL until diarization runs (or when it
-- finds no overlapping speaker). Distinct from the existing `speaker` column,
-- which records the audio source ('mic' or 'system').
ALTER TABLE transcripts ADD COLUMN speaker_id INTEGER;
