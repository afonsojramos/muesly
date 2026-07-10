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
    pub meeting_count: u32,
    pub meetings: Vec<PersonMeetingRef>,
}

/// Parse attendee display names from a calendar snapshot JSON array.
pub fn names_from_attendees_json(raw: &str) -> Vec<String> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = val.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for a in arr {
        let name = a
            .get("name")
            .and_then(|n| n.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let is_self = a.get("is_self").and_then(|b| b.as_bool()).unwrap_or(false);
        if is_self {
            continue;
        }
        if let Some(n) = name {
            if !out.iter().any(|x: &String| x == n) {
                out.push(n.to_string());
            }
        }
    }
    out
}

/// Aggregate people from (meeting_id, title, created_at, attendees_json) rows.
pub fn aggregate_people(
    rows: Vec<(String, String, String, Option<String>)>,
) -> Vec<PersonGroup> {
    use std::collections::BTreeMap;
    let mut map: BTreeMap<String, PersonGroup> = BTreeMap::new();
    for (meeting_id, title, created_at, attendees) in rows {
        let Some(json) = attendees else { continue };
        for name in names_from_attendees_json(&json) {
            let entry = map.entry(name.clone()).or_insert_with(|| PersonGroup {
                name: name.clone(),
                meeting_count: 0,
                meetings: Vec::new(),
            });
            entry.meeting_count += 1;
            entry.meetings.push(PersonMeetingRef {
                meeting_id: meeting_id.clone(),
                title: title.clone(),
                created_at: created_at.clone(),
            });
        }
    }
    let mut groups: Vec<_> = map.into_values().collect();
    groups.sort_by(|a, b| b.meeting_count.cmp(&a.meeting_count).then(a.name.cmp(&b.name)));
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
    fn aggregates_counts() {
        let rows = vec![
            (
                "m1".into(),
                "Sync".into(),
                "2026-01-01".into(),
                Some(r#"[{"name":"Bruno","is_self":false}]"#.into()),
            ),
            (
                "m2".into(),
                "Plan".into(),
                "2026-01-02".into(),
                Some(r#"[{"name":"Bruno","is_self":false},{"name":"Cara","is_self":false}]"#.into()),
            ),
        ];
        let g = aggregate_people(rows);
        assert_eq!(g[0].name, "Bruno");
        assert_eq!(g[0].meeting_count, 2);
        assert_eq!(g[1].name, "Cara");
        assert_eq!(g[1].meeting_count, 1);
    }
}
