-- Snapshot of the calendar event that was happening when a recording started.
-- 1:1 with a meeting (the recording itself), mirroring meeting_notes.
-- Snapshot semantics: fields are copied at record time and never re-derived from
-- the live calendar. Attendee/organizer EMAILS are intentionally NOT stored -
-- nothing consumes them and they are third-party PII (see plan / ADR 0001).
CREATE TABLE IF NOT EXISTS calendar_events (
    meeting_id TEXT PRIMARY KEY NOT NULL,
    event_identifier TEXT,        -- EventKit series id (NOT unique per occurrence)
    occurrence_start TEXT,        -- RFC3339; disambiguates the recurring instance
    title TEXT,
    start_time TEXT,              -- RFC3339
    end_time TEXT,                -- RFC3339
    organizer_name TEXT,          -- name only, no email
    attendees_json TEXT,          -- JSON [{name,status}] - names only, NO emails
    location TEXT,
    conference_url TEXT,
    notes TEXT,                   -- scrubbed + length-capped
    calendar_name TEXT,
    source TEXT NOT NULL DEFAULT 'eventkit',
    match_confidence TEXT NOT NULL DEFAULT 'manual', -- high | low | manual
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_meeting_id ON calendar_events(meeting_id);

-- Calendar context settings on the single-row settings table (id='1').
-- Master opt-in, off by default (privacy-first).
ALTER TABLE settings ADD COLUMN calendar_context_enabled INTEGER NOT NULL DEFAULT 0;
-- JSON array of EventKit calendar identifiers the user excluded from matching.
ALTER TABLE settings ADD COLUMN calendar_excluded_ids TEXT;
-- Send attendee/organizer NAMES to remote (cloud) summary providers. Off by default.
ALTER TABLE settings ADD COLUMN calendar_send_attendee_names_to_cloud INTEGER NOT NULL DEFAULT 0;
-- Send event NOTES/agenda to remote (cloud) summary providers. Off by default.
ALTER TABLE settings ADD COLUMN calendar_send_notes_to_cloud INTEGER NOT NULL DEFAULT 0;
