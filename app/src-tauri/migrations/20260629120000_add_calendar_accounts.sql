-- Calendar sources: the local EventKit source (one synthetic row) plus one row
-- per connected Google account. Refresh tokens live in the OS keychain, never
-- here. The connected account's own email is stored only as a display label and
-- never leaves the device. Attendee emails are never stored anywhere.
CREATE TABLE IF NOT EXISTS calendar_accounts (
    id TEXT PRIMARY KEY NOT NULL,           -- google 'sub', or 'eventkit-local'
    source TEXT NOT NULL,                    -- 'eventkit' | 'google'
    email TEXT,                              -- display label (NULL for eventkit)
    enabled INTEGER NOT NULL DEFAULT 1,
    excluded_calendar_ids TEXT,             -- JSON array, per-account
    status TEXT,                             -- 'reauth_required' (NULL = ok)
    created_at TEXT NOT NULL
);

-- Which source won dedup for a snapshot, plus the cross-system UID.
-- Deliberately NOT foreign keys: snapshots outlive accounts (disconnect keeps
-- history), and SQLite cannot add a FK via ALTER TABLE anyway.
ALTER TABLE calendar_events ADD COLUMN account_id TEXT;
ALTER TABLE calendar_events ADD COLUMN ical_uid TEXT;

-- Backfill the local EventKit source from the existing single-source settings.
-- enabled=1 means the source is on within the master gate; the master toggle
-- (settings.calendar_context_enabled) remains the overall feature switch, so its
-- prior value is preserved separately and not duplicated here.
INSERT OR IGNORE INTO calendar_accounts (id, source, email, enabled, excluded_calendar_ids, status, created_at)
SELECT
    'eventkit-local',
    'eventkit',
    NULL,
    1,
    (SELECT calendar_excluded_ids FROM settings WHERE id = '1' LIMIT 1),
    NULL,
    datetime('now');
