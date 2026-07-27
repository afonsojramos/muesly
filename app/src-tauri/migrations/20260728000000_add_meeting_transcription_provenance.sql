-- Which engine/model produced the meeting's current transcript and why it was
-- chosen (surfaced in meeting details). Stamped when a live recording or import
-- saves, and rewritten when a retranscription/quality pass replaces the
-- transcript. NULL on meetings from before this existed and after an undo
-- restores a transcript whose provenance is unknown.
ALTER TABLE meetings ADD COLUMN transcription_provider TEXT;
ALTER TABLE meetings ADD COLUMN transcription_model TEXT;
ALTER TABLE meetings ADD COLUMN transcription_reason TEXT;
