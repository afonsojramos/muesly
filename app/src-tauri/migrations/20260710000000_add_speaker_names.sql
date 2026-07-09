-- Human-assigned name for a diarized speaker cluster, scoped to one meeting.
-- (meeting_id, speaker_id) is the cluster identity within a meeting; `name` is
-- what the user picked (a calendar attendee or free text). Cleared and recomputed
-- on re-diarization because cluster numbering is not stable across runs. Scoped
-- per meeting: no cross-meeting voice identity is stored, and no email is kept.
CREATE TABLE IF NOT EXISTS speaker_names (
    meeting_id TEXT NOT NULL,
    speaker_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (meeting_id, speaker_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
