//! People & companies: group meetings by attendee display name.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Runtime};

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PersonMeetingRef {
    pub meeting_id: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PersonGroup {
    pub name: String,
    /// Best-effort org label from the attendee's email domain, when available.
    pub company: Option<String>,
    pub meeting_count: u32,
    pub meetings: Vec<PersonMeetingRef>,
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

/// Aggregate people from (meeting_id, title, created_at, attendees_json) rows.
pub fn aggregate_people(
    rows: Vec<(String, String, String, Option<String>)>,
) -> Vec<PersonGroup> {
    use std::collections::BTreeMap;
    let mut map: BTreeMap<String, PersonGroup> = BTreeMap::new();
    for (meeting_id, title, created_at, attendees) in rows {
        let Some(json) = attendees else { continue };
        for att in attendees_from_json(&json) {
            let entry = map.entry(att.name.clone()).or_insert_with(|| PersonGroup {
                name: att.name.clone(),
                company: att.company.clone(),
                meeting_count: 0,
                meetings: Vec::new(),
            });
            // Prefer the first non-empty company we see for this person.
            if entry.company.is_none() {
                entry.company = att.company;
            }
            entry.meeting_count += 1;
            entry.meetings.push(PersonMeetingRef {
                meeting_id: meeting_id.clone(),
                title: title.clone(),
                created_at: created_at.clone(),
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
    Ok(aggregate_people(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let g = aggregate_people(rows);
        assert_eq!(g[0].name, "Bruno");
        assert_eq!(g[0].meeting_count, 2);
        assert_eq!(g[0].company.as_deref(), Some("Acme"));
        assert_eq!(g[1].name, "Cara");
        assert_eq!(g[1].meeting_count, 1);
        assert!(g[1].company.is_none());
    }
}
