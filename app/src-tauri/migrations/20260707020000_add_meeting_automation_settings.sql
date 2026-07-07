-- When a calendar meeting begins, start recording it automatically (opt-in;
-- default off since unattended audio capture is privacy-sensitive) and,
-- optionally, open its conference link.
ALTER TABLE settings ADD COLUMN auto_start_on_event INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN auto_join_meeting INTEGER NOT NULL DEFAULT 0;
