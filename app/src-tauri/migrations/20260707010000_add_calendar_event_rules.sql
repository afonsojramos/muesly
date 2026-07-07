-- Pre-assign a calendar event (or a whole recurring series) to a folder, ahead of
-- any recording existing for it. Unlike `calendar_events` (a post-recording snapshot
-- keyed by an existing meeting_id), this captures *future intent*.
--
-- occurrence_minute is minute_bucket(occurrence_start) = start.timestamp() / 60, so a
-- Google `dateTime` and a float-reconstructed EventKit instant for the same occurrence
-- collapse to one key. The sentinel -1 marks a rule that applies to the whole series.
CREATE TABLE IF NOT EXISTS calendar_event_rules (
    id TEXT PRIMARY KEY,
    ical_uid TEXT NOT NULL,
    event_identifier TEXT,
    occurrence_minute INTEGER NOT NULL,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    applies_to_series INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (ical_uid, occurrence_minute)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_rules_uid ON calendar_event_rules (ical_uid);
