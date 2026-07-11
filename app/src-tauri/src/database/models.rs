use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct MeetingModel {
    pub id: String,
    pub title: String,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub folder_path: Option<String>,
    /// Organizing folder this meeting belongs to (NULL = uncategorized).
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct FolderModel {
    pub id: String,
    pub name: String,
    /// Optional emoji icon (NULL when unset).
    pub emoji: Option<String>,
    /// Parent folder id (NULL = root; nesting is one level deep).
    pub parent_id: Option<String>,
    /// When the folder was favorited (NULL = not a favorite).
    pub favorited_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::Type, specta::Type)]
#[sqlx(transparent)]
pub struct DateTimeUtc(pub DateTime<Utc>);

impl From<NaiveDateTime> for DateTimeUtc {
    fn from(naive: NaiveDateTime) -> Self {
        DateTimeUtc(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
    }
}

// Renamed from TranscriptSegment to Transcript to match the table name
#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct Transcript {
    pub id: String,
    pub meeting_id: String,
    pub transcript: String,
    pub timestamp: String,
    pub summary: Option<String>,
    pub action_items: Option<String>,
    pub key_points: Option<String>,
    // Recording-relative timestamps for audio-transcript synchronization
    pub audio_start_time: Option<f64>,
    pub audio_end_time: Option<f64>,
    pub duration: Option<f64>,
    /// Audio source: "mic" (the user) or "system" (other participants)
    pub speaker: Option<String>,
    /// Diarized speaker cluster index (set after diarization), else None.
    pub speaker_id: Option<i64>,
}

/// A human-assigned name for a diarized speaker cluster within one meeting.
/// `(meeting_id, speaker_id)` is the cluster identity; scoped per meeting, no
/// cross-meeting voice identity and no email.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct SpeakerName {
    pub meeting_id: String,
    pub speaker_id: i64,
    pub name: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct SummaryProcess {
    pub meeting_id: String,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub error: Option<String>,
    pub result: Option<String>, // JSON
    pub start_time: Option<chrono::DateTime<chrono::Utc>>,
    pub end_time: Option<chrono::DateTime<chrono::Utc>>,
    pub chunk_count: i64,
    pub processing_time: f64,
    pub metadata: Option<String>,      // JSON
    pub result_backup: Option<String>, // Backup of result before regeneration
    pub result_backup_timestamp: Option<chrono::DateTime<chrono::Utc>>, // When backup was created
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct MeetingNotes {
    pub meeting_id: String,
    /// User-typed notes as markdown (canonical persisted shape).
    pub notes_markdown: Option<String>,
    /// Reserved for future structured/dual-color notes; currently always NULL.
    pub notes_json: Option<String>,
    /// Per-meeting context the user types to steer AI summary generation.
    pub summary_context: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Snapshot of the calendar event a recording was matched to, taken at record
/// time. 1:1 with a meeting. Emails are never stored (see migration / plan).
#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct CalendarEvent {
    pub meeting_id: String,
    /// EventKit series identifier (shared across recurring occurrences).
    pub event_identifier: Option<String>,
    /// Occurrence start (RFC3339) that disambiguates a recurring instance.
    pub occurrence_start: Option<String>,
    pub title: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    /// Organizer display name only - never an email address.
    pub organizer_name: Option<String>,
    /// JSON array of `{name, status}` - names only, never emails.
    pub attendees_json: Option<String>,
    pub location: Option<String>,
    pub conference_url: Option<String>,
    /// Event notes/agenda, secret-scrubbed and length-capped before storage.
    pub notes: Option<String>,
    pub calendar_name: Option<String>,
    /// Origin of the snapshot: "eventkit" or "google".
    pub source: String,
    /// Which calendar account won dedup (e.g. "eventkit-local" or a Google sub).
    pub account_id: Option<String>,
    /// Cross-system event UID (EventKit external id / Google iCalUID).
    pub ical_uid: Option<String>,
    /// How the event was matched: "high", "low", or "manual".
    pub match_confidence: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// A calendar source the user has connected. The local EventKit source is one
/// synthetic row ("eventkit-local"); each connected Google account is one row
/// keyed by its Google `sub`. Refresh tokens live in the keychain, not here.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct CalendarAccount {
    /// Google `sub`, or the sentinel "eventkit-local".
    pub id: String,
    /// "eventkit" or "google".
    pub source: String,
    /// Display label (the account email for Google; NULL for the local source).
    pub email: Option<String>,
    pub enabled: bool,
    /// JSON array of excluded calendar ids, scoped to this account.
    pub excluded_calendar_ids: Option<String>,
    /// "reauth_required" when the token is dead; NULL means healthy.
    pub status: Option<String>,
    pub created_at: String,
    /// Cached JSON array of the account's calendars (`Vec<CalendarInfo>`), so the
    /// settings page renders without a live Google call. NULL until first fetched;
    /// refreshed on connect and on an explicit manual refresh.
    pub calendars_json: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct TranscriptChunk {
    pub meeting_id: String,
    pub meeting_name: Option<String>,
    pub transcript_text: String,
    pub model: String,
    pub model_name: String,
    pub chunk_size: Option<i64>,
    pub overlap: Option<i64>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct Setting {
    pub id: String,
    pub provider: String,
    pub model: String,
    #[sqlx(rename = "whisperModel")]
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[sqlx(rename = "groqApiKey")]
    #[serde(rename = "groqApiKey")]
    pub groq_api_key: Option<String>,
    #[sqlx(rename = "openaiApiKey")]
    #[serde(rename = "openaiApiKey")]
    pub openai_api_key: Option<String>,
    #[sqlx(rename = "anthropicApiKey")]
    #[serde(rename = "anthropicApiKey")]
    pub anthropic_api_key: Option<String>,
    #[sqlx(rename = "ollamaApiKey")]
    #[serde(rename = "ollamaApiKey")]
    pub ollama_api_key: Option<String>,
    #[sqlx(rename = "openRouterApiKey")]
    #[serde(rename = "openRouterApiKey")]
    pub open_router_api_key: Option<String>,
    #[sqlx(rename = "xaiApiKey")]
    #[serde(rename = "xaiApiKey")]
    pub xai_api_key: Option<String>,
    #[sqlx(rename = "ollamaEndpoint")]
    #[serde(rename = "ollamaEndpoint")]
    pub ollama_endpoint: Option<String>,
    /// Custom OpenAI-compatible endpoint configuration stored as JSON
    #[sqlx(rename = "customOpenAIConfig")]
    #[serde(rename = "customOpenAIConfig")]
    pub custom_openai_config: Option<String>,
    /// Persisted transcription language preference (whisper code, "auto", or
    /// "auto-translate"). NULL falls back to "auto".
    #[sqlx(rename = "transcriptionLanguage")]
    #[serde(rename = "transcriptionLanguage")]
    pub transcription_language: Option<String>,
}

impl Setting {
    /// Parse the custom OpenAI config from JSON string
    pub fn get_custom_openai_config(&self) -> Option<crate::summary::CustomOpenAIConfig> {
        self.custom_openai_config
            .as_ref()
            .and_then(|json| serde_json::from_str(json).ok())
    }
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, specta::Type)]
pub struct TranscriptSetting {
    pub id: String,
    pub provider: String,
    pub model: String,
    #[sqlx(rename = "whisperApiKey")]
    #[serde(rename = "whisperApiKey")]
    pub whisper_api_key: Option<String>,
    #[sqlx(rename = "deepgramApiKey")]
    #[serde(rename = "deepgramApiKey")]
    pub deepgram_api_key: Option<String>,
    #[sqlx(rename = "elevenLabsApiKey")]
    #[serde(rename = "elevenLabsApiKey")]
    pub eleven_labs_api_key: Option<String>,
    #[sqlx(rename = "groqApiKey")]
    #[serde(rename = "groqApiKey")]
    pub groq_api_key: Option<String>,
    #[sqlx(rename = "openaiApiKey")]
    #[serde(rename = "openaiApiKey")]
    pub openai_api_key: Option<String>,
}
