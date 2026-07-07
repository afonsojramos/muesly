-- Records that the meeting-start scheduler has already fired its actions for a
-- given occurrence, so a fire is exactly-once across restarts (an in-memory set
-- would re-fire after a restart mid-meeting). Keyed on the same (normalized uid,
-- minute bucket) identity the calendar dedup uses.
CREATE TABLE IF NOT EXISTS scheduler_fired (
    ical_uid TEXT NOT NULL,
    occurrence_minute INTEGER NOT NULL,
    fired_at TEXT NOT NULL,
    PRIMARY KEY (ical_uid, occurrence_minute)
);
