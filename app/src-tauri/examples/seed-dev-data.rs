//! Dev-only: populate the app database with fake meetings, folders, transcripts,
//! summaries, calendar attendees, notes, and speaker names so the UI (sidebar
//! folders/favorites/subfolders, home recency buckets, search, People, meeting
//! details) can be exercised without recording anything.
//!
//! Writes to the SAME SQLite DB the app uses
//! (`<app data>/com.muesly/meeting_minutes.sqlite`), so the app picks the data
//! up on its next fetch (navigate away and back, or restart, to refresh).
//!
//! Usage (from repo root):
//!   cargo run -q -p muesly --example seed-dev-data              # seed / refresh
//!   cargo run -q -p muesly --example seed-dev-data -- --clear   # remove seed data
//!   cargo run -q -p muesly --example seed-dev-data -- --db PATH # explicit DB file
//!
//! Every seeded row uses an id prefixed `seed-`, so re-running replaces prior
//! seed data (idempotent) and real recordings are never touched.

use std::path::PathBuf;

use chrono::{Duration, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{AssertSqlSafe, Executor, SqlitePool};

const SEED_PREFIX: &str = "seed-";

fn fail(msg: String) -> ! {
    eprintln!("seed-dev-data: {msg}");
    std::process::exit(1);
}

/// Resolve the app's SQLite DB path the same way the Tauri app does
/// (`app_data_dir()/meeting_minutes.sqlite`). `dirs::data_dir()` maps to the
/// platform's app-data root that Tauri's `app_data_dir` joins the bundle id to.
fn default_db_path() -> PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(|| fail("could not resolve the platform data directory".into()));
    base.join("com.muesly").join("meeting_minutes.sqlite")
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let mut clear = false;
    let mut db_override: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--clear" => clear = true,
            "--db" => {
                db_override = Some(PathBuf::from(
                    args.next()
                        .unwrap_or_else(|| fail("--db requires a path".into())),
                ))
            }
            other => fail(format!("unknown argument: {other}")),
        }
    }

    let db_path = db_override.unwrap_or_else(default_db_path);
    eprintln!("Using database: {}", db_path.display());

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap_or_else(|e| fail(format!("failed to open database: {e}")));

    // Ensure the schema exists (idempotent; a no-op when the app already ran it).
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .unwrap_or_else(|e| fail(format!("failed to run migrations: {e}")));

    clear_seed(&pool).await;
    if clear {
        eprintln!("Removed all seed data.");
        return;
    }

    seed(&pool).await;
    eprintln!(
        "Seeded {} folders and {} meetings. Navigate away and back in the app to see them.",
        FOLDERS.len(),
        MEETINGS.len()
    );
}

/// Delete every `seed-`-prefixed row. Children are deleted explicitly (not via
/// FK cascade) so the transcripts FTS delete-trigger fires and the index stays
/// consistent.
async fn clear_seed(pool: &SqlitePool) {
    let child_tables = [
        ("calendar_events", "meeting_id"),
        ("speaker_names", "meeting_id"),
        ("meeting_notes", "meeting_id"),
        ("summary_processes", "meeting_id"),
        ("transcript_chunks", "meeting_id"),
        ("chat_messages", "meeting_id"),
        ("transcripts", "meeting_id"),
    ];
    // Table/column names are hardcoded above (never user input), so the
    // dynamically built DELETE is safe to assert.
    for (table, col) in child_tables {
        let sql = format!("DELETE FROM {table} WHERE {col} LIKE ?");
        sqlx::query(AssertSqlSafe(sql))
            .bind(format!("{SEED_PREFIX}%"))
            .execute(pool)
            .await
            .unwrap_or_else(|e| fail(format!("clear {table}: {e}")));
    }
    for table in ["folder_context_items", "meetings", "folders"] {
        let sql = format!("DELETE FROM {table} WHERE id LIKE ?");
        sqlx::query(AssertSqlSafe(sql))
            .bind(format!("{SEED_PREFIX}%"))
            .execute(pool)
            .await
            .unwrap_or_else(|e| fail(format!("clear {table}: {e}")));
    }
}

struct SeedFolder {
    id: &'static str,
    name: &'static str,
    emoji: &'static str,
    parent: Option<&'static str>,
    favorite: bool,
}

struct SeedMeeting {
    id: &'static str,
    title: &'static str,
    /// Whole days before now; drives the home recency buckets.
    days_ago: i64,
    folder: Option<&'static str>,
    trashed: bool,
    /// (speaker, text). `speaker` is "mic" (you) or "system" (remote).
    segments: &'static [(&'static str, &'static str)],
    /// Attendee display names (non-self), for the People page.
    attendees: &'static [&'static str],
    summary_markdown: &'static str,
    notes: Option<&'static str>,
    /// (speaker_id, name) labels applied to diarized clusters.
    speaker_names: &'static [(i64, &'static str)],
    /// (role, content) "Ask anything" turns; role is "user" or "assistant".
    chat: &'static [(&'static str, &'static str)],
}

const FOLDERS: &[SeedFolder] = &[
    SeedFolder {
        id: "seed-folder-work",
        name: "Work",
        emoji: "💼",
        parent: None,
        favorite: true,
    },
    SeedFolder {
        id: "seed-folder-personal",
        name: "Personal",
        emoji: "🏡",
        parent: None,
        favorite: false,
    },
    SeedFolder {
        id: "seed-folder-1on1s",
        name: "1:1s",
        emoji: "👥",
        parent: Some("seed-folder-work"),
        favorite: false,
    },
];

struct SeedMemory {
    id: &'static str,
    folder: &'static str,
    kind: &'static str,
    content: &'static str,
    /// "user" or "extracted" (extracted renders the Auto badge).
    source: &'static str,
    pinned: bool,
    /// Seed meeting the memory was "learned" from (extracted items only;
    /// renders the provenance chip). Inserted after meetings, so any seed
    /// meeting id is valid here.
    source_meeting: Option<&'static str>,
}

const MEMORIES: &[SeedMemory] = &[
    SeedMemory {
        id: "seed-mem-work-atlas",
        folder: "seed-folder-work",
        kind: "glossary",
        content: "Atlas = the Kubernetes migration project",
        source: "user",
        pinned: true,
        source_meeting: None,
    },
    SeedMemory {
        id: "seed-mem-work-decision",
        folder: "seed-folder-work",
        kind: "decision",
        content: "Ship the beta on March 10; analytics milestone follows in Q3",
        source: "extracted",
        pinned: false,
        source_meeting: Some("seed-meeting-sprint"),
    },
    SeedMemory {
        id: "seed-mem-work-maya",
        folder: "seed-folder-work",
        kind: "note",
        content: "Maya owns payments and the mobile launch budget",
        source: "extracted",
        pinned: false,
        source_meeting: Some("seed-meeting-sprint"),
    },
    SeedMemory {
        id: "seed-mem-work-pref",
        folder: "seed-folder-work",
        kind: "preference",
        content: "Always list decisions before action items in summaries",
        source: "user",
        pinned: false,
        source_meeting: None,
    },
    SeedMemory {
        id: "seed-mem-work-search",
        folder: "seed-folder-work",
        kind: "note",
        content: "Search rollout revisits after the budget review",
        source: "extracted",
        pinned: false,
        source_meeting: Some("seed-meeting-roadmap"),
    },
    SeedMemory {
        id: "seed-mem-1on1-alex",
        folder: "seed-folder-1on1s",
        kind: "note",
        content: "Alex prefers written follow-ups over ad-hoc calls",
        source: "extracted",
        pinned: false,
        source_meeting: Some("seed-meeting-1on1-alex"),
    },
    SeedMemory {
        id: "seed-mem-personal-dentist",
        folder: "seed-folder-personal",
        kind: "note",
        content: "Dentist follow-up is due in six months",
        source: "user",
        pinned: false,
        source_meeting: None,
    },
];

const MEETINGS: &[SeedMeeting] = &[
    SeedMeeting {
        id: "seed-meeting-sprint",
        title: "Sprint Planning",
        days_ago: 1,
        folder: Some("seed-folder-work"),
        trashed: false,
        segments: &[
            (
                "mic",
                "Morning everyone, let's lock the scope for this sprint.",
            ),
            (
                "system",
                "I think the Kubernetes migration should be the top priority.",
            ),
            (
                "mic",
                "Agreed. Let's also finalize the budget for the mobile launch.",
            ),
            (
                "system",
                "Action item for Alex: send the revised timeline by Friday.",
            ),
            (
                "mic",
                "Great, decision made: we ship the beta on March tenth.",
            ),
        ],
        attendees: &["Alex Rivera", "Priya Shah"],
        summary_markdown: "## Sprint Planning\n\n**Decisions**\n- Ship the beta on March 10.\n- Kubernetes migration is top priority this sprint.\n\n**Action items**\n- Alex: send the revised timeline by Friday.\n- Finalize the mobile launch budget.",
        notes: Some("Remember to double-check the staging cluster capacity before the migration."),
        speaker_names: &[(0, "Alex Rivera"), (1, "Priya Shah")],
        chat: &[
            ("user", "What did we decide about the beta launch?"),
            (
                "assistant",
                "You decided to ship the beta on March 10, with the Kubernetes migration as the top priority for this sprint.",
            ),
            ("user", "Who owns the timeline?"),
            (
                "assistant",
                "Alex is the action-item owner: send the revised timeline by Friday.",
            ),
        ],
    },
    SeedMeeting {
        id: "seed-meeting-roadmap",
        title: "Q3 Roadmap Review",
        days_ago: 2,
        folder: Some("seed-folder-work"),
        trashed: false,
        segments: &[
            ("mic", "Let's walk through the Q3 roadmap and hiring plan."),
            (
                "system",
                "We need two more engineers to hit the analytics milestone.",
            ),
            (
                "mic",
                "The roadmap looks solid, but the timeline for search is tight.",
            ),
            (
                "system",
                "Let's revisit the search rollout after the budget review.",
            ),
        ],
        attendees: &["Priya Shah", "Marcus Lee"],
        summary_markdown: "## Q3 Roadmap Review\n\n- Hiring: two engineers needed for the analytics milestone.\n- Search rollout timeline is tight; revisit after budget review.",
        notes: None,
        speaker_names: &[(0, "Priya Shah")],
        chat: &[],
    },
    SeedMeeting {
        id: "seed-meeting-1on1-alex",
        title: "1:1 with Alex",
        days_ago: 3,
        folder: Some("seed-folder-1on1s"),
        trashed: false,
        segments: &[
            ("mic", "How are things going on the migration work?"),
            (
                "system",
                "Good, though I'm blocked on the staging environment access.",
            ),
            (
                "mic",
                "I'll get you access today. Anything else on your mind?",
            ),
            (
                "system",
                "I'd love to take on more of the roadmap planning next quarter.",
            ),
        ],
        attendees: &["Alex Rivera"],
        summary_markdown: "## 1:1 with Alex\n\n- Alex blocked on staging access (unblocking today).\n- Interested in owning more roadmap planning next quarter.",
        notes: Some("Follow up on staging access. Alex wants growth into planning."),
        speaker_names: &[(0, "Alex Rivera")],
        chat: &[],
    },
    SeedMeeting {
        id: "seed-meeting-design",
        title: "Design Critique",
        days_ago: 5,
        folder: Some("seed-folder-work"),
        trashed: false,
        segments: &[
            ("mic", "Let's review the new onboarding flow designs."),
            (
                "system",
                "The empty states feel a little sparse, maybe add guidance.",
            ),
            (
                "mic",
                "Good call. The color contrast on the buttons needs work too.",
            ),
        ],
        attendees: &["Dana Wu", "Marcus Lee"],
        summary_markdown: "## Design Critique\n\n- Add guidance to empty states in onboarding.\n- Improve button color contrast for accessibility.",
        notes: None,
        speaker_names: &[],
        chat: &[],
    },
    SeedMeeting {
        id: "seed-meeting-standup",
        title: "Team Standup",
        days_ago: 8,
        folder: Some("seed-folder-work"),
        trashed: false,
        segments: &[
            ("mic", "Quick standup: what's everyone working on today?"),
            (
                "system",
                "Finishing the search indexing, then reviewing the budget doc.",
            ),
            ("mic", "I'm pairing with Dana on the onboarding flow."),
        ],
        attendees: &["Dana Wu", "Alex Rivera", "Priya Shah"],
        summary_markdown: "## Team Standup\n\n- Search indexing wrapping up.\n- Onboarding flow pairing in progress.",
        notes: None,
        speaker_names: &[],
        chat: &[],
    },
    SeedMeeting {
        id: "seed-meeting-dentist",
        title: "Dentist Appointment Notes",
        days_ago: 6,
        folder: Some("seed-folder-personal"),
        trashed: false,
        segments: &[
            (
                "mic",
                "Reminder to book the follow-up cleaning for next month.",
            ),
            ("system", "Everything looks healthy, see you in six months."),
        ],
        attendees: &[],
        summary_markdown: "## Dentist\n\n- Book follow-up cleaning next month.\n- Next checkup in six months.",
        notes: Some("Insurance covered the cleaning. Book online."),
        speaker_names: &[],
        chat: &[],
    },
    SeedMeeting {
        id: "seed-meeting-uncategorized",
        title: "Coffee Chat with Marcus",
        days_ago: 4,
        folder: None,
        trashed: false,
        segments: &[
            (
                "mic",
                "Thanks for grabbing coffee. How's the new team treating you?",
            ),
            (
                "system",
                "Really well. The hiring push is paying off already.",
            ),
        ],
        attendees: &["Marcus Lee"],
        summary_markdown: "## Coffee Chat\n\n- Marcus settling into the new team well.\n- Hiring push is paying off.",
        notes: None,
        speaker_names: &[],
        chat: &[],
    },
    SeedMeeting {
        id: "seed-meeting-old",
        title: "Kickoff: Analytics Project",
        days_ago: 21,
        folder: Some("seed-folder-work"),
        trashed: false,
        segments: &[
            ("mic", "Welcome to the analytics project kickoff."),
            (
                "system",
                "Our goal is a self-serve dashboard by end of quarter.",
            ),
            (
                "mic",
                "Let's define the key metrics and the data pipeline first.",
            ),
        ],
        attendees: &["Priya Shah", "Dana Wu"],
        summary_markdown: "## Analytics Kickoff\n\n- Goal: self-serve dashboard by end of quarter.\n- Next: define key metrics and the data pipeline.",
        notes: None,
        speaker_names: &[],
        chat: &[],
    },
    SeedMeeting {
        id: "seed-meeting-trashed",
        title: "Cancelled Vendor Call",
        days_ago: 7,
        folder: None,
        trashed: true,
        segments: &[("mic", "This call was cancelled, no content.")],
        attendees: &["External Vendor"],
        summary_markdown: "## Vendor Call\n\n- Cancelled.",
        notes: None,
        speaker_names: &[],
        chat: &[],
    },
];

async fn seed(pool: &SqlitePool) {
    let now = Utc::now();

    for f in FOLDERS {
        let ts = now.to_rfc3339();
        let favorited_at = f.favorite.then(|| ts.clone());
        sqlx::query(
            "INSERT INTO folders (id, name, emoji, parent_id, favorited_at, created_at, updated_at, context_in_summaries, memory_extraction) \
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)",
        )
        .bind(f.id)
        .bind(f.name)
        .bind(f.emoji)
        .bind(f.parent)
        .bind(favorited_at)
        .bind(&ts)
        .bind(&ts)
        .execute(pool)
        .await
        .unwrap_or_else(|e| fail(format!("insert folder {}: {e}", f.id)));
    }

    for m in MEETINGS {
        let created = now - Duration::days(m.days_ago);
        let created_ts = created.to_rfc3339();
        let deleted_at = m.trashed.then(|| now.to_rfc3339());

        sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, folder_path, deleted_at, folder_id) \
             VALUES (?, ?, ?, ?, NULL, ?, ?)",
        )
        .bind(m.id)
        .bind(m.title)
        .bind(&created_ts)
        .bind(&created_ts)
        .bind(deleted_at)
        .bind(m.folder)
        .execute(pool)
        .await
        .unwrap_or_else(|e| fail(format!("insert meeting {}: {e}", m.id)));

        // Transcript segments: give each a plausible audio time span and a
        // recording-relative HH:MM:SS timestamp. Inserting fires the FTS
        // triggers, so seeded meetings are searchable.
        for (i, (speaker, text)) in m.segments.iter().enumerate() {
            let start = (i as f64) * 12.0;
            let end = start + 11.0;
            let clock = format!("{:02}:{:02}", (start as u64) / 60, (start as u64) % 60);
            sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(format!("{}-seg-{i}", m.id))
            .bind(m.id)
            .bind(*text)
            .bind(clock)
            .bind(start)
            .bind(end)
            .bind(end - start)
            .bind(*speaker)
            .execute(pool)
            .await
            .unwrap_or_else(|e| fail(format!("insert transcript {}: {e}", m.id)));
        }

        // Calendar snapshot with attendee names (drives the People page). Names
        // only — the real app never stores attendee emails.
        if !m.attendees.is_empty() {
            let attendees_json = serde_json::to_string(
                &m.attendees
                    .iter()
                    .map(|n| serde_json::json!({ "name": n, "status": "accepted", "is_self": false }))
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            sqlx::query(
                "INSERT INTO calendar_events (meeting_id, title, start_time, attendees_json, source, match_confidence, created_at) \
                 VALUES (?, ?, ?, ?, 'eventkit', 'high', ?)",
            )
            .bind(m.id)
            .bind(m.title)
            .bind(&created_ts)
            .bind(attendees_json)
            .bind(&created_ts)
            .execute(pool)
            .await
            .unwrap_or_else(|e| fail(format!("insert calendar_event {}: {e}", m.id)));
        }

        // Completed markdown-first summary.
        let result = serde_json::json!({ "markdown": m.summary_markdown }).to_string();
        sqlx::query(
            "INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, start_time, end_time, result) \
             VALUES (?, 'completed', ?, ?, ?, ?, ?)",
        )
        .bind(m.id)
        .bind(&created_ts)
        .bind(&created_ts)
        .bind(&created_ts)
        .bind(&created_ts)
        .bind(result)
        .execute(pool)
        .await
        .unwrap_or_else(|e| fail(format!("insert summary {}: {e}", m.id)));

        if let Some(notes) = m.notes {
            sqlx::query(
                "INSERT INTO meeting_notes (meeting_id, notes_markdown, created_at, updated_at) \
                 VALUES (?, ?, ?, ?)",
            )
            .bind(m.id)
            .bind(notes)
            .bind(&created_ts)
            .bind(&created_ts)
            .execute(pool)
            .await
            .unwrap_or_else(|e| fail(format!("insert notes {}: {e}", m.id)));
        }

        for (speaker_id, name) in m.speaker_names {
            pool.execute(
                sqlx::query(
                    "INSERT INTO speaker_names (meeting_id, speaker_id, name) VALUES (?, ?, ?)",
                )
                .bind(m.id)
                .bind(speaker_id)
                .bind(*name),
            )
            .await
            .unwrap_or_else(|e| fail(format!("insert speaker_name {}: {e}", m.id)));
        }

        // Persisted "Ask anything" chat turns, so the in-meeting chat has a
        // thread (its panel starts collapsed as a "Continue chat" pill).
        for (i, (role, content)) in m.chat.iter().enumerate() {
            let ts = (created + Duration::seconds(i as i64)).to_rfc3339();
            sqlx::query(
                "INSERT INTO chat_messages (id, meeting_id, role, content, created_at) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(format!("{}-chat-{i}", m.id))
            .bind(m.id)
            .bind(*role)
            .bind(*content)
            .bind(ts)
            .execute(pool)
            .await
            .unwrap_or_else(|e| fail(format!("insert chat {}: {e}", m.id)));
        }
    }

    // Folder memory items (user-authored and auto-learned), inserted after
    // meetings so extracted items can reference their source meeting. Drives
    // the folder page's Memory section (incl. provenance chips), the scoped AI
    // bar, and summary injection.
    let memory_ts = now.to_rfc3339();
    for mem in MEMORIES {
        sqlx::query(
            "INSERT INTO folder_context_items \
             (id, folder_id, kind, content, source, status, pinned, created_at, updated_at, \
              source_meeting_id) \
             VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)",
        )
        .bind(mem.id)
        .bind(mem.folder)
        .bind(mem.kind)
        .bind(mem.content)
        .bind(mem.source)
        .bind(mem.pinned as i64)
        .bind(&memory_ts)
        .bind(&memory_ts)
        .bind(mem.source_meeting)
        .execute(pool)
        .await
        .unwrap_or_else(|e| fail(format!("insert folder memory {}: {e}", mem.id)));
    }
}
