-- Provenance of the snapshotted transcript itself: which engine/model produced
-- it and why it was chosen, captured from the meetings row at snapshot time so
-- undoing to a revision restores the true attribution instead of clearing it.
-- (The existing `model` column keeps its own meaning: the model of the pass
-- that replaced the snapshot.) NULL on revisions from before this existed,
-- which undo then restores as an honest "unknown".
ALTER TABLE transcript_revisions ADD COLUMN transcription_provider TEXT;
ALTER TABLE transcript_revisions ADD COLUMN transcription_model TEXT;
ALTER TABLE transcript_revisions ADD COLUMN transcription_reason TEXT;
