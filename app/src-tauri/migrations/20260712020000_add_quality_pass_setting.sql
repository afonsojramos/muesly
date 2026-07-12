-- Whether to re-transcribe each finished meeting with the batch pipeline
-- (merged VAD windows, no realtime pressure). Default off (extra compute).
ALTER TABLE settings ADD COLUMN post_meeting_quality_pass INTEGER;
