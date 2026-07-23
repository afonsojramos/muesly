-- Provenance for learned folder memories: which meeting a memory was extracted
-- from. NULL for user-authored items and for memories whose source meeting was
-- permanently deleted (ON DELETE SET NULL keeps the memory, drops the link).
ALTER TABLE folder_context_items ADD COLUMN source_meeting_id TEXT
    REFERENCES meetings(id) ON DELETE SET NULL;
