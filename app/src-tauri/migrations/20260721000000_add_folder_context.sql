-- Folder context store: user-curated memory attached to a sidebar folder
-- (project glossary, standing preferences, decisions worth remembering). The
-- assembled block can be injected into folder-scoped chat and, when enabled,
-- into that folder's summary prompts. Items with source 'extracted' arrive as
-- pending proposals from the post-summary memory pass and become visible
-- context only after the user accepts them.

CREATE TABLE IF NOT EXISTS folder_context_items (
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'note'
        CHECK (kind IN ('note', 'glossary', 'preference', 'decision')),
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user'
        CHECK (source IN ('user', 'extracted')),
    status TEXT NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('pending', 'accepted')),
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,                  -- RFC3339
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folder_context_items_folder
    ON folder_context_items(folder_id, status);

-- Per-folder feature toggles (default off: context only enters prompts when
-- the folder owner asks for it).
ALTER TABLE folders ADD COLUMN context_in_summaries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN memory_extraction INTEGER NOT NULL DEFAULT 0;
