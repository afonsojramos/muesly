-- User-authored chat bars: reusable prompts the user saves for the "Ask
-- anything" (per-meeting) and "Ask your meetings" (global) chats. Built-in and
-- imported bars live in the frontend catalog; only user-created ones are
-- persisted here so they survive restarts and can be edited/deleted.
--
-- `scenarios` tags a bar Granola-style (before/during/after a meeting, or across
-- meetings) for grouping/filtering and to decide which chat surface offers it.
CREATE TABLE IF NOT EXISTS bars (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    scenarios TEXT NOT NULL DEFAULT 'after',  -- comma-separated: before,during,after,across
    icon TEXT NOT NULL DEFAULT 'sparkles',
    created_at TEXT NOT NULL,                  -- RFC3339
    updated_at TEXT NOT NULL
);
