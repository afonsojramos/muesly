-- Squashed baseline schema (collapses the prior incremental migrations into one).
-- Represents the full schema as of 2026-06-16. All statements are idempotent.

-- User-created folders for organizing meetings in the sidebar (distinct from
-- meetings.folder_path, which points at the on-disk audio recording folder).
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- On-disk folder holding the meeting's audio recording.
    folder_path TEXT,
    -- Soft delete (Trash): NULL = active, a timestamp = trashed at that time.
    deleted_at TEXT,
    -- Sidebar folder membership; NULL = uncategorized. Detaches on folder delete.
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    transcript TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    summary TEXT,
    action_items TEXT,
    key_points TEXT,
    -- Audio-transcript sync, in seconds from recording start.
    audio_start_time REAL,
    audio_end_time REAL,
    duration REAL,
    -- Audio source the segment came from: 'mic' or 'system'.
    speaker TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS summary_processes (
    meeting_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    error TEXT,
    result TEXT,
    start_time TEXT,
    end_time TEXT,
    chunk_count INTEGER DEFAULT 0,
    processing_time REAL DEFAULT 0.0,
    metadata TEXT,
    -- Preserves the previous summary when regeneration fails or is cancelled.
    result_backup TEXT,
    result_backup_timestamp TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcript_chunks (
    meeting_id TEXT PRIMARY KEY,
    meeting_name TEXT,
    transcript_text TEXT NOT NULL,
    model TEXT NOT NULL,
    model_name TEXT NOT NULL,
    chunk_size INTEGER,
    overlap INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    whisperModel TEXT NOT NULL,
    groqApiKey TEXT,
    openaiApiKey TEXT,
    anthropicApiKey TEXT,
    ollamaApiKey TEXT,
    openRouterApiKey TEXT,
    ollamaEndpoint TEXT,
    customOpenAIConfig TEXT,
    geminiApiKey TEXT
);

CREATE TABLE IF NOT EXISTS transcript_settings (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    whisperApiKey TEXT,
    deepgramApiKey TEXT,
    elevenLabsApiKey TEXT,
    groqApiKey TEXT,
    openaiApiKey TEXT
);

-- RSA-based PRO licensing.
CREATE TABLE IF NOT EXISTS licensing (
    license_key TEXT PRIMARY KEY,           -- Decrypted license ID
    encrypted_key TEXT NOT NULL,            -- Original encrypted key (RSA + Base64)
    signature_hash TEXT NOT NULL,           -- SHA-256 hash of encrypted_key for integrity
    activation_date TEXT NOT NULL,          -- ISO 8601 timestamp of activation
    expiry_date TEXT NOT NULL,              -- activation_date + duration
    soft_expiry_date TEXT NOT NULL,         -- expiry_date + grace period
    max_activation_time TEXT NOT NULL,      -- From decrypted license data
    duration INTEGER NOT NULL,              -- Duration in seconds
    generated_on TEXT NOT NULL,             -- ISO 8601 timestamp when license was generated
    is_soft_expired INTEGER DEFAULT 0,      -- 0=active, 1=soft expired, 2=hard blocked
    grace_period INTEGER NOT NULL DEFAULT 604800 -- Seconds of grace after expiry (default 7 days)
);

-- Per-meeting user notes and the context that steers AI summary generation.
CREATE TABLE IF NOT EXISTS meeting_notes (
    meeting_id TEXT PRIMARY KEY NOT NULL,
    notes_markdown TEXT,
    notes_json TEXT,
    summary_context TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meetings_deleted_at ON meetings(deleted_at);
CREATE INDEX IF NOT EXISTS idx_meetings_folder_id ON meetings(folder_id);
CREATE INDEX IF NOT EXISTS idx_meeting_notes_meeting_id ON meeting_notes(meeting_id);
