-- Preserve the human-facing bar invocation separately from the full prompt sent
-- to the model. Both columns are nullable so ordinary chat turns remain unchanged.
ALTER TABLE chat_messages ADD COLUMN bar_id TEXT;
ALTER TABLE chat_messages ADD COLUMN display_text TEXT;
