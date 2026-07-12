-- Persisted "Ask anything" chat threads, one per meeting. Messages are written
-- as turns complete (the user question up front, the assistant answer when the
-- stream finishes), so collapsing or navigating away never loses a conversation
-- and a "Recent chats" list can be derived. Live recordings use an ephemeral
-- meeting id that is not in `meetings` yet - those turns stay in-memory only
-- (the insert is guarded on the meeting row existing).
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    role TEXT NOT NULL,            -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,      -- RFC3339
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_meeting_id ON chat_messages(meeting_id);
