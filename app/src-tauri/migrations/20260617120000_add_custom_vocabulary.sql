-- Stores the user's custom transcription vocabulary as a JSON array of
-- { "from": "...", "to": "..." } correction pairs. NULL/absent means none.
ALTER TABLE settings ADD COLUMN customVocabulary TEXT;
