//! Post-summary folder memory learning (on by default for every folder).
//!
//! After a summary completes for a meeting in a folder with
//! `memory_extraction` enabled, one small LLM pass compares the new summary
//! against the folder's current memories and learns durable additions.
//! Extracted memories are accepted immediately and surface in the folder's
//! Memory section with an Auto badge; they are never silent — the section
//! shows everything learned and the user can edit or delete any of it.
//! Everything runs on the already-configured provider, so local setups keep
//! the pass fully on-device.

use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter as _, Manager, Runtime};
use tracing::{info, warn};

use crate::database::repositories::folder_context::FolderContextRepository;
use crate::summary::llm_client::{LLMProvider, generate_summary};

/// Input fed to the reconcile pass (tail-truncated like chat reads).
const MAX_SUMMARY_CHARS: usize = 6_000;
const MAX_MEMORY_LIST_CHARS: usize = 2_000;
const MAX_PROPOSALS: usize = 3;
const PROPOSE_MAX_TOKENS: u32 = 512;

#[derive(Debug, Deserialize)]
struct ReconcileOutput {
    #[serde(default)]
    operations: Vec<ReconcileOp>,
}

#[derive(Debug, Deserialize)]
struct ReconcileOp {
    op: String,
    kind: Option<String>,
    content: Option<String>,
}

fn reconcile_prompts(folder_name: &str, memories: &str, summary: &str) -> (String, String) {
    let system = "You maintain the long-term memory of one meeting folder. You decide which \
facts are worth remembering for future conversations about this folder: durable decisions, \
standing preferences, project glossary, and stable facts about people or projects. You never \
remember one-off details, scheduling trivia, or anything already remembered. You answer with \
ONLY one JSON object and nothing else."
        .to_string();
    let user = format!(
        "Folder: \"{folder_name}\"\n\nCurrent memories:\n<memories>\n{memories}\n</memories>\n\n\
New meeting summary:\n<summary>\n{summary}\n</summary>\n\n\
Reply with ONLY one JSON object in this exact shape:\n\
{{\"operations\": [{{\"op\": \"add\", \"kind\": \"note|glossary|preference|decision\", \
\"content\": \"<one short statement>\"}}]}}\n\
Rules: at most {MAX_PROPOSALS} operations; only durable facts; never repeat anything already \
in <memories>; if nothing is worth remembering, reply {{\"operations\": []}}."
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

/// Runs the proposal pass for one completed summary. Best-effort: failures
/// are logged and never surface to the summary pipeline.
#[allow(clippy::too_many_arguments)]
pub async fn propose_folder_memories<R: Runtime>(
    app: &AppHandle<R>,
    pool: &SqlitePool,
    folder_id: &str,
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
    let mut memories = String::new();
    for item in &existing {
        let line = format!("- [{}] {}\n", item.kind, item.content.trim());
        if memories.len() + line.len() > MAX_MEMORY_LIST_CHARS {
            break;
        }
        memories.push_str(&line);
    }
    if memories.is_empty() {
        memories.push_str("(none yet)\n");
    }

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
        Some(PROPOSE_MAX_TOKENS).or(max_tokens),
        temperature,
        top_p,
        app.path().app_data_dir().ok().as_ref(),
        None,
    )
    .await
    {
        Ok(raw) => raw,
        Err(e) => {
            warn!("folder memory proposal pass failed for {folder_id}: {e}");
            return;
        }
    };

    let Some(output) = parse_reconcile_output(&raw) else {
        warn!("folder memory proposal pass returned no JSON for {folder_id}");
        return;
    };

    let mut inserted = 0usize;
    for op in output.operations.into_iter().take(MAX_PROPOSALS) {
        if op.op != "add" {
            continue;
        }
        let (Some(kind), Some(content)) = (op.kind, op.content) else {
            continue;
        };
        match FolderContextRepository::insert_pending(pool, folder_id, &kind, &content).await {
            Ok(true) => inserted += 1,
            Ok(false) => {}
            Err(e) => warn!("folder memory proposal rejected for {folder_id}: {e}"),
        }
    }

    if inserted > 0 {
        info!("proposed {inserted} folder memor(ies) for {folder_id}");
        let _ = app.emit(
            "folder-memory-proposed",
            serde_json::json!({ "folder_id": folder_id, "count": inserted }),
        );
    }
}
