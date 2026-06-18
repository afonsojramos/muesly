-- Persist the user's transcription language preference so it survives restarts.
-- Previously this lived only in an in-memory static (defaulting to "auto-translate")
-- mirrored through the frontend's localStorage; the settings DB is now the source
-- of truth. Nullable, no default: existing rows keep NULL and fall back to "auto".
ALTER TABLE settings ADD COLUMN transcriptionLanguage TEXT;
