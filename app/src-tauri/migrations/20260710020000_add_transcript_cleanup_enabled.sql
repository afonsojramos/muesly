-- Opt-in: run an LLM cleanup pass on the transcript before summarizing.
-- Default off: adds latency (and cost for cloud models).
ALTER TABLE settings ADD COLUMN transcript_cleanup_enabled INTEGER NOT NULL DEFAULT 0;
