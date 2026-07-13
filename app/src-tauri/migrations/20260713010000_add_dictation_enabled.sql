-- Persist whether push-to-talk dictation is enabled so the setting (and the
-- keep-the-model-warm behavior) survives an app restart instead of resetting to
-- off each launch.
ALTER TABLE settings ADD COLUMN dictation_enabled INTEGER NOT NULL DEFAULT 0;
