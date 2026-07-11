-- Custom global shortcut accelerators (NULL = built-in default).
ALTER TABLE settings ADD COLUMN recording_shortcut TEXT;
ALTER TABLE settings ADD COLUMN dictation_shortcut TEXT;
