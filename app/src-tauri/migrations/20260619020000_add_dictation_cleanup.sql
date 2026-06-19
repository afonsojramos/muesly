-- Optional local-AI cleanup of dictated text before it is injected. Off by default.
ALTER TABLE settings ADD COLUMN dictation_cleanup_enabled INTEGER NOT NULL DEFAULT 0;

-- Reusable cleanup instructions for dictation. At most one row is active
-- (is_active = 1); the active preset's prompt drives the cleanup pass.
CREATE TABLE IF NOT EXISTS dictation_cleanup_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

INSERT INTO dictation_cleanup_presets (id, name, prompt, is_active, created_at)
VALUES (
    'default',
    'Grammar & punctuation',
    'Fix the grammar, punctuation, and capitalization of the user''s dictated text. Preserve the original meaning and wording as closely as possible. Output only the corrected text, with no preamble, quotes, or commentary.',
    1,
    '2026-06-19T00:00:00Z'
);
