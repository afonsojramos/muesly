//! People & companies: group meetings by attendee display name.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use tauri::{AppHandle, Runtime};

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PersonMeetingRef {
    pub meeting_id: String,
    pub title: String,
    pub created_at: String,
    /// Seconds this person spoke in the meeting, when named-speaker data links
    /// them (diarization + name assignment). `None` = no data, never zero.
    pub speech_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PersonGroup {
    pub name: String,
    /// Best-effort org label from the attendee's email domain, when available.
    pub company: Option<String>,
    pub meeting_count: u32,
    pub meetings: Vec<PersonMeetingRef>,
    /// Total speaking time across linked meetings. `None` when no meeting has
    /// named-speaker data for this person (renders exactly as before).
    pub speech_seconds: Option<f64>,
}

/// Best-effort company/org label from an email domain (e.g. alice@acme.com → Acme).
pub fn company_from_email(email: &str) -> Option<String> {
    let domain = email.split('@').nth(1)?.trim().to_lowercase();
    if domain.is_empty()
        || domain == "gmail.com"
        || domain == "yahoo.com"
        || domain == "hotmail.com"
        || domain == "outlook.com"
        || domain == "icloud.com"
        || domain == "me.com"
        || domain == "googlemail.com"
    {
        return None;
    }
    let base = domain.split('.').next().unwrap_or(&domain);
    if base.is_empty() {
        return None;
    }
    let mut chars = base.chars();
    let first = chars.next()?.to_uppercase().collect::<String>();
    Some(format!("{first}{}", chars.as_str()))
}

/// One non-self attendee: display name + optional company from email.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttendeeRef {
    pub name: String,
    pub company: Option<String>,
}

/// Parse non-self attendees from a calendar snapshot JSON array.
pub fn attendees_from_json(raw: &str) -> Vec<AttendeeRef> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = val.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for a in arr {
        let is_self = a.get("is_self").and_then(|b| b.as_bool()).unwrap_or(false);
        if is_self {
            continue;
        }
        let name = a
            .get("name")
            .and_then(|n| n.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let Some(name) = name else { continue };
        if out.iter().any(|x: &AttendeeRef| x.name == name) {
            continue;
        }
        let email = a
            .get("email")
            .and_then(|e| e.as_str())
            .or_else(|| a.get("email_address").and_then(|e| e.as_str()))
            .unwrap_or("");
        let company = company_from_email(email);
        out.push(AttendeeRef { name, company });
    }
    out
}

/// Display names only (compat for callers that only need names).
pub fn names_from_attendees_json(raw: &str) -> Vec<String> {
    attendees_from_json(raw)
        .into_iter()
        .map(|a| a.name)
        .collect()
}

/// Normalization shared with the speech query's `lower(trim(name))`. ASCII-only
/// case folding (SQLite `lower()` is ASCII) — names stored verbatim from the
/// same attendee shortlist still match, which is the dominant path.
fn norm_name(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Speech seconds keyed by `(meeting_id, normalized speaker name)`.
pub type SpeechMap = HashMap<(String, String), f64>;

/// Aggregate people from (meeting_id, title, created_at, attendees_json) rows,
/// attaching per-meeting and total speech time where `speech` links a person by
/// normalized name. Absent data stays `None` (never zero).
pub fn aggregate_people(
    rows: Vec<(String, String, String, Option<String>)>,
    speech: &SpeechMap,
) -> Vec<PersonGroup> {
    use std::collections::BTreeMap;
    let mut map: BTreeMap<String, PersonGroup> = BTreeMap::new();
    for (meeting_id, title, created_at, attendees) in rows {
        let Some(json) = attendees else { continue };
        for att in attendees_from_json(&json) {
            let seconds = speech
                .get(&(meeting_id.clone(), norm_name(&att.name)))
                .copied();
            let entry = map.entry(att.name.clone()).or_insert_with(|| PersonGroup {
                name: att.name.clone(),
                company: att.company.clone(),
                meeting_count: 0,
                meetings: Vec::new(),
                speech_seconds: None,
            });
            // Prefer the first non-empty company we see for this person.
            if entry.company.is_none() {
                entry.company = att.company;
            }
            entry.meeting_count += 1;
            if let Some(s) = seconds {
                entry.speech_seconds = Some(entry.speech_seconds.unwrap_or(0.0) + s);
            }
            entry.meetings.push(PersonMeetingRef {
                meeting_id: meeting_id.clone(),
                title: title.clone(),
                created_at: created_at.clone(),
                speech_seconds: seconds,
            });
        }
    }
    let mut groups: Vec<_> = map.into_values().collect();
    groups.sort_by(|a, b| {
        b.meeting_count
            .cmp(&a.meeting_count)
            .then(a.name.cmp(&b.name))
    });
    groups
}

#[tauri::command]
#[specta::specta]
pub async fn api_list_people<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PersonGroup>, String> {
    let pool = state.db_manager.pool();
    list_people(pool).await.map_err(|e| e.to_string())
}

async fn list_people(pool: &SqlitePool) -> Result<Vec<PersonGroup>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        "SELECT m.id, m.title, m.created_at, c.attendees_json \
         FROM meetings m \
         LEFT JOIN calendar_events c ON c.meeting_id = m.id \
         WHERE m.deleted_at IS NULL \
         ORDER BY m.created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    let speech = speech_map(pool).await?;
    Ok(aggregate_people(rows, &speech))
}

/// Speech seconds per `(meeting_id, normalized speaker name)`, from named
/// diarized clusters joined to their `system` transcript segments. The duration
/// CASE mirrors `talk_time_groups`: stored duration when positive, else the
/// segment's time span; rows with no usable signal drop out.
async fn speech_map(pool: &SqlitePool) -> Result<SpeechMap, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String, f64)>(
        "SELECT sn.meeting_id, lower(trim(sn.name)) AS norm_name, \
                SUM(CASE \
                    WHEN t.duration IS NOT NULL AND t.duration > 0 THEN t.duration \
                    WHEN t.audio_start_time IS NOT NULL AND t.audio_end_time IS NOT NULL \
                         AND t.audio_end_time > t.audio_start_time \
                        THEN t.audio_end_time - t.audio_start_time \
                    ELSE 0 END) AS seconds \
         FROM speaker_names sn \
         JOIN transcripts t ON t.meeting_id = sn.meeting_id AND t.speaker_id = sn.speaker_id \
         WHERE t.speaker = 'system' \
         GROUP BY sn.meeting_id, norm_name \
         HAVING seconds > 0",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(meeting_id, name, seconds)| ((meeting_id, name), seconds))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_speech() -> SpeechMap {
        SpeechMap::new()
    }

    #[test]
    fn extracts_non_self_names() {
        let json = r#"[{"name":"Ana","is_self":true},{"name":"Bruno","is_self":false}]"#;
        assert_eq!(names_from_attendees_json(json), vec!["Bruno".to_string()]);
    }

    #[test]
    fn company_from_work_email() {
        assert_eq!(
            company_from_email("alice@acme.com").as_deref(),
            Some("Acme")
        );
        assert!(company_from_email("bob@gmail.com").is_none());
    }

    #[test]
    fn attendee_company_from_email_field() {
        let json = r#"[{"name":"Bruno","email":"bruno@acme.io","is_self":false}]"#;
        let a = attendees_from_json(json);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].company.as_deref(), Some("Acme"));
    }

    #[test]
    fn aggregates_counts() {
        let rows = vec![
            (
                "m1".into(),
                "Sync".into(),
                "2026-01-01".into(),
                Some(r#"[{"name":"Bruno","email":"b@acme.com","is_self":false}]"#.into()),
            ),
            (
                "m2".into(),
                "Plan".into(),
                "2026-01-02".into(),
                Some(
                    r#"[{"name":"Bruno","email":"b@acme.com","is_self":false},{"name":"Cara","is_self":false}]"#.into(),
                ),
            ),
        ];
        let g = aggregate_people(rows, &no_speech());
        assert_eq!(g[0].name, "Bruno");
        assert_eq!(g[0].meeting_count, 2);
        assert_eq!(g[0].company.as_deref(), Some("Acme"));
        assert!(g[0].speech_seconds.is_none(), "no data stays None, not zero");
        assert_eq!(g[1].name, "Cara");
        assert_eq!(g[1].meeting_count, 1);
        assert!(g[1].company.is_none());
    }

    #[test]
    fn attaches_speech_time_case_insensitively() {
        let rows = vec![
            (
                "m1".into(),
                "Sync".into(),
                "2026-01-01".into(),
                // Attendee name has trailing whitespace + different case than
                // the stored speaker name — must still link (R4).
                Some(r#"[{"name":"ana ","is_self":false}]"#.into()),
            ),
            (
                "m2".into(),
                "Plan".into(),
                "2026-01-02".into(),
                Some(r#"[{"name":"ana ","is_self":false}]"#.into()),
            ),
        ];
        let mut speech = SpeechMap::new();
        speech.insert(("m1".into(), "ana".into()), 120.0);

        let g = aggregate_people(rows, &speech);
        assert_eq!(g[0].name, "ana");
        assert_eq!(g[0].speech_seconds, Some(120.0));
        let m1 = g[0].meetings.iter().find(|m| m.meeting_id == "m1").unwrap();
        let m2 = g[0].meetings.iter().find(|m| m.meeting_id == "m2").unwrap();
        assert_eq!(m1.speech_seconds, Some(120.0));
        assert!(m2.speech_seconds.is_none(), "unlinked meeting stays None");
    }

    #[test]
    fn case_variant_duplicate_attendees_each_show_the_same_speech() {
        // Accepted quirk: exact-name dedupe upstream means "Ana" and "ana" in one
        // meeting form two groups, both matching the same normalized speech entry.
        let rows = vec![(
            "m1".into(),
            "Sync".into(),
            "2026-01-01".into(),
            Some(r#"[{"name":"Ana","is_self":false},{"name":"ana","is_self":false}]"#.into()),
        )];
        let mut speech = SpeechMap::new();
        speech.insert(("m1".into(), "ana".into()), 60.0);

        let g = aggregate_people(rows, &speech);
        assert_eq!(g.len(), 2);
        assert!(g.iter().all(|p| p.speech_seconds == Some(60.0)));
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use chrono::Utc;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn insert_meeting(pool: &SqlitePool, id: &str, title: &str) {
        let now = Utc::now();
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(title)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await
            .expect("insert meeting");
    }

    async fn insert_event(pool: &SqlitePool, meeting_id: &str, attendees_json: &str) {
        sqlx::query(
            "INSERT INTO calendar_events (meeting_id, attendees_json, created_at) VALUES (?, ?, ?)",
        )
        .bind(meeting_id)
        .bind(attendees_json)
        .bind(Utc::now())
        .execute(pool)
        .await
        .expect("insert event");
    }

    async fn insert_segment(
        pool: &SqlitePool,
        meeting_id: &str,
        id: &str,
        speaker: &str,
        speaker_id: Option<i64>,
        duration: Option<f64>,
        span: Option<(f64, f64)>,
    ) {
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker, speaker_id) \
             VALUES (?, ?, 'text', '00:00:01', ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(meeting_id)
        .bind(span.map(|s| s.0))
        .bind(span.map(|s| s.1))
        .bind(duration)
        .bind(speaker)
        .bind(speaker_id)
        .execute(pool)
        .await
        .expect("insert segment");
    }

    #[tokio::test]
    async fn links_speech_to_people_end_to_end() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1", "Sync").await;
        insert_event(
            &pool,
            "m1",
            r#"[{"name":"Ana","is_self":true},{"name":"Bruno","is_self":false}]"#,
        )
        .await;
        // Bruno = cluster 0: 30s + 90s of system speech; mic speech must not count.
        sqlx::query("INSERT INTO speaker_names (meeting_id, speaker_id, name) VALUES ('m1', 0, 'Bruno')")
            .execute(&pool)
            .await
            .expect("name");
        insert_segment(&pool, "m1", "s1", "system", Some(0), Some(30.0), Some((0.0, 30.0))).await;
        insert_segment(&pool, "m1", "s2", "system", Some(0), None, Some((40.0, 130.0))).await;
        insert_segment(&pool, "m1", "s3", "mic", None, Some(500.0), Some((0.0, 500.0))).await;

        let people = list_people(&pool).await.expect("list");
        let bruno = people.iter().find(|p| p.name == "Bruno").expect("bruno");
        assert_eq!(bruno.speech_seconds, Some(120.0));
        assert_eq!(bruno.meetings[0].speech_seconds, Some(120.0));
        // Ana is self — not a person group at all.
        assert!(people.iter().all(|p| p.name != "Ana"));
    }

    #[tokio::test]
    async fn unlinked_people_and_meetings_stay_none() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1", "Sync").await;
        insert_event(&pool, "m1", r#"[{"name":"Cara","is_self":false}]"#).await;
        // Diarized speech exists but under a different assigned name.
        sqlx::query("INSERT INTO speaker_names (meeting_id, speaker_id, name) VALUES ('m1', 0, 'Someone Else')")
            .execute(&pool)
            .await
            .expect("name");
        insert_segment(&pool, "m1", "s1", "system", Some(0), Some(10.0), None).await;

        let people = list_people(&pool).await.expect("list");
        let cara = people.iter().find(|p| p.name == "Cara").expect("cara");
        assert!(cara.speech_seconds.is_none());
        assert!(cara.meetings[0].speech_seconds.is_none());
    }
}
