-- User-authored chat bars: reusable prompts the user saves for the "Ask
-- anything" (per-meeting) and "Ask your meetings" (global) chats. Built-in and
-- imported bars live in the frontend catalog; only user-created ones are
-- persisted here so they survive restarts and can be edited/deleted.
CREATE TABLE IF NOT EXISTS bars (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'meeting',  -- comma-separated: 'meeting','global'
    icon TEXT NOT NULL DEFAULT 'sparkles',
    created_at TEXT NOT NULL,                 -- RFC3339
    updated_at TEXT NOT NULL
);
