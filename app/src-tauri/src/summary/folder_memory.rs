//! Post-summary folder memory reconciliation (on by default for every folder).
//!
//! After a summary completes for a meeting in a folder with
//! `memory_extraction` enabled, one small LLM pass compares the new summary
//! against the folder's current memories and reconciles them: it can add new
//! durable facts, rewrite learned memories that the meeting superseded, and
//! retire learned memories that are now wrong or expired. User-authored
//! memories are shown to the model for dedup context but are never editable —
//! only `extracted` items can be updated or deleted, and the repository
//! enforces that independently of the prompt. Nothing is silent: every learned
//! memory is visible in the folder's Memory section (with its source meeting)
//! and the user can edit or delete any of it. Everything runs on the
//! already-configured provider, so local setups keep the pass fully on-device.

use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter as _, Manager, Runtime};
use tracing::{info, warn};

use crate::database::repositories::folder_context::{FolderContextItem, FolderContextRepository};
use crate::summary::llm_client::{LLMProvider, generate_summary};

/// Input fed to the reconcile pass (tail-truncated like chat reads).
const MAX_SUMMARY_CHARS: usize = 6_000;
const MAX_MEMORY_LIST_CHARS: usize = 2_500;
/// Total operations applied per pass, and how many of them may be additions.
const MAX_OPERATIONS: usize = 5;
const MAX_ADDS: usize = 3;
const RECONCILE_MAX_TOKENS: u32 = 512;

#[derive(Debug, Deserialize)]
struct ReconcileOutput {
    #[serde(default)]
    operations: Vec<ReconcileOp>,
}

#[derive(Debug, Deserialize)]
struct ReconcileOp {
    op: String,
    /// `[#n]` reference from the memory list (update/delete only).
    #[serde(rename = "ref")]
    reference: Option<usize>,
    kind: Option<String>,
    content: Option<String>,
}

/// Numbered memory list for the prompt plus the index → item mapping used to
/// resolve `ref` values. Only `(auto)` entries are legal update/delete targets.
fn render_memory_list(items: &[FolderContextItem]) -> (String, Vec<FolderContextItem>) {
    let mut listed = Vec::new();
    let mut text = String::new();
    for item in items {
        let origin = if item.source == "extracted" { "auto" } else { "user" };
        let line = format!(
            "[#{}] [{}] ({origin}) {}\n",
            listed.len() + 1,
            item.kind,
            item.content.trim()
        );
        if text.len() + line.len() > MAX_MEMORY_LIST_CHARS {
            break;
        }
        text.push_str(&line);
        listed.push(item.clone());
    }
    if text.is_empty() {
        text.push_str("(none yet)\n");
    }
    (text, listed)
}

fn reconcile_prompts(folder_name: &str, memories: &str, summary: &str) -> (String, String) {
    let system = "You maintain the long-term memory of one meeting folder. You decide which \
facts are worth remembering for future conversations about this folder: durable decisions, \
standing preferences, project glossary, and stable facts about people or projects. You never \
remember one-off details or scheduling trivia. You keep the memory current: when the new \
meeting supersedes, corrects, or expires an existing (auto) memory, you update or delete that \
memory instead of adding a near-duplicate. Memories marked (user) were written by the user and \
must never be updated or deleted. You answer with ONLY one JSON object and nothing else."
        .to_string();
    let user = format!(
        "Folder: \"{folder_name}\"\n\nCurrent memories:\n<memories>\n{memories}\n</memories>\n\n\
New meeting summary:\n<summary>\n{summary}\n</summary>\n\n\
Reply with ONLY one JSON object in this exact shape:\n\
{{\"operations\": [\n\
  {{\"op\": \"add\", \"kind\": \"note|glossary|preference|decision\", \"content\": \"<one short statement>\"}},\n\
  {{\"op\": \"update\", \"ref\": <number from [#n]>, \"kind\": \"note|glossary|preference|decision\", \"content\": \"<replacement statement>\"}},\n\
  {{\"op\": \"delete\", \"ref\": <number from [#n]>}}\n\
]}}\n\
Rules: at most {MAX_OPERATIONS} operations and at most {MAX_ADDS} adds; update/delete only \
(auto) memories; prefer update over add when the fact already exists in another form; if \
nothing changes, reply {{\"operations\": []}}."
    );
    (system, user)
}

/// Extract the first balanced JSON object from model output (tolerates
/// leading prose or code fences, never guesses beyond the last brace).
fn parse_reconcile_output(raw: &str) -> Option<ReconcileOutput> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&raw[start..=end]).ok()
}

/// Runs the reconcile pass for one completed summary. Best-effort: failures
/// are logged and never surface to the summary pipeline.
#[allow(clippy::too_many_arguments)]
pub async fn propose_folder_memories<R: Runtime>(
    app: &AppHandle<R>,
    pool: &SqlitePool,
    folder_id: &str,
    meeting_id: &str,
    summary_markdown: &str,
    provider: &LLMProvider,
    model_name: &str,
    api_key: &str,
    ollama_endpoint: Option<&str>,
    custom_openai_endpoint: Option<&str>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
) {
    let folder_name = sqlx::query_scalar::<_, String>("SELECT name FROM folders WHERE id = ?")
        .bind(folder_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "this folder".to_string());

    let existing = FolderContextRepository::list_items(pool, folder_id)
        .await
        .unwrap_or_default();
    let (memories, listed) = render_memory_list(&existing);

    let summary_tail: String = {
        let chars: Vec<char> = summary_markdown.chars().collect();
        if chars.len() > MAX_SUMMARY_CHARS {
            chars[chars.len() - MAX_SUMMARY_CHARS..].iter().collect()
        } else {
            summary_markdown.to_string()
        }
    };

    let (system, user) = reconcile_prompts(&folder_name, &memories, &summary_tail);
    let client = crate::providers::common::http_client();
    let raw = match generate_summary(
        &client,
        provider,
        model_name,
        api_key,
        &system,
        &user,
        ollama_endpoint,
        custom_openai_endpoint,
        Some(RECONCILE_MAX_TOKENS).or(max_tokens),
        temperature,
        top_p,
        app.path().app_data_dir().ok().as_ref(),
        None,
    )
    .await
    {
        Ok(raw) => raw,
        Err(e) => {
            warn!("folder memory reconcile pass failed for {folder_id}: {e}");
            return;
        }
    };

    let Some(output) = parse_reconcile_output(&raw) else {
        warn!("folder memory reconcile pass returned no JSON for {folder_id}");
        return;
    };

    let mut added = 0usize;
    let mut updated = 0usize;
    let mut deleted = 0usize;
    for op in output.operations.into_iter().take(MAX_OPERATIONS) {
        match op.op.as_str() {
            "add" if added < MAX_ADDS => {
                let (Some(kind), Some(content)) = (op.kind, op.content) else {
                    continue;
                };
                match FolderContextRepository::insert_extracted(
                    pool,
                    folder_id,
                    &kind,
                    &content,
                    Some(meeting_id),
                )
                .await
                {
                    Ok(true) => added += 1,
                    Ok(false) => {}
                    Err(e) => warn!("folder memory add rejected for {folder_id}: {e}"),
                }
            }
            "update" => {
                let Some(target) = op.reference.and_then(|r| listed.get(r.checked_sub(1)?)) else {
                    continue;
                };
                let Some(content) = op.content else { continue };
                // A missing/invalid kind keeps the memory's current kind.
                let kind = op.kind.as_deref().unwrap_or(&target.kind);
                let kind = if ["note", "glossary", "preference", "decision"].contains(&kind) {
                    kind
                } else {
                    &target.kind
                };
                match FolderContextRepository::update_extracted(
                    pool, folder_id, &target.id, kind, &content,
                )
                .await
                {
                    Ok(true) => updated += 1,
                    // False = target was user-authored or vanished; the repo
                    // guard is the real boundary, the prompt only advises.
                    Ok(false) => {}
                    Err(e) => warn!("folder memory update rejected for {folder_id}: {e}"),
                }
            }
            "delete" => {
                let Some(target) = op.reference.and_then(|r| listed.get(r.checked_sub(1)?)) else {
                    continue;
                };
                match FolderContextRepository::delete_extracted(pool, folder_id, &target.id).await {
                    Ok(true) => deleted += 1,
                    Ok(false) => {}
                    Err(e) => warn!("folder memory delete rejected for {folder_id}: {e}"),
                }
            }
            _ => {}
        }
    }

    if added + updated + deleted > 0 {
        info!(
            "reconciled folder memories for {folder_id}: +{added} ~{updated} -{deleted} (from {meeting_id})"
        );
        let _ = app.emit(
            "folder-memory-updated",
            serde_json::json!({
                "folder_id": folder_id,
                "added": added,
                "updated": updated,
                "deleted": deleted,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, source: &str, kind: &str, content: &str) -> FolderContextItem {
        FolderContextItem {
            id: id.to_string(),
            folder_id: "f1".to_string(),
            kind: kind.to_string(),
            content: content.to_string(),
            source: source.to_string(),
            status: "accepted".to_string(),
            pinned: false,
            created_at: "x".to_string(),
            updated_at: "x".to_string(),
            source_meeting_id: None,
            source_meeting_title: None,
        }
    }

    #[test]
    fn memory_list_numbers_items_and_marks_origin() {
        let items = vec![
            item("a", "user", "note", "User note"),
            item("b", "extracted", "decision", "Ship March 10"),
        ];
        let (text, listed) = render_memory_list(&items);
        assert!(text.contains("[#1] [note] (user) User note"));
        assert!(text.contains("[#2] [decision] (auto) Ship March 10"));
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[1].id, "b");
    }

    #[test]
    fn memory_list_caps_and_stays_aligned_with_references() {
        let items: Vec<FolderContextItem> = (0..100)
            .map(|i| item(&format!("id-{i}"), "extracted", "note", &"x".repeat(80)))
            .collect();
        let (text, listed) = render_memory_list(&items);
        assert!(text.len() <= MAX_MEMORY_LIST_CHARS + 100);
        // Every rendered [#n] must resolve through `listed[n-1]`.
        assert_eq!(text.matches("[#").count(), listed.len());
    }

    #[test]
    fn reconcile_output_parses_all_ops_and_tolerates_prose() {
        let raw = "Sure! {\"operations\": [\
            {\"op\": \"add\", \"kind\": \"note\", \"content\": \"New fact\"},\
            {\"op\": \"update\", \"ref\": 2, \"content\": \"Refined\"},\
            {\"op\": \"delete\", \"ref\": 3}\
        ]} thanks";
        let output = parse_reconcile_output(raw).unwrap();
        assert_eq!(output.operations.len(), 3);
        assert_eq!(output.operations[1].reference, Some(2));
        assert!(output.operations[2].kind.is_none());
        assert!(parse_reconcile_output("no json here").is_none());
    }
}
