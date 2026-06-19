-- Whether muesly watches for known meeting apps coming to the foreground and
-- offers to start recording. Off by default.
ALTER TABLE settings ADD COLUMN auto_detect_meetings INTEGER NOT NULL DEFAULT 0;
