//! Natural-language search across meetings: FTS-style LIKE retrieval + packed context.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::database::repositories::transcript::TranscriptsRepository;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NlSearchHit {
    pub meeting_id: String,
    pub title: String,
    pub match_context: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NlSearchResponse {
    pub query: String,
    pub hits: Vec<NlSearchHit>,
    /// Context block suitable for pasting into a chat/LLM follow-up.
    pub context_pack: String,
}

/// Cap hits so the pack stays within local model context.
pub const MAX_NL_HITS: usize = 12;

/// Build a context pack from ranked hits for LLM Q&A.
pub fn build_context_pack(query: &str, hits: &[NlSearchHit]) -> String {
    let mut out = format!("Query: {}\n\nRelevant meeting snippets:\n", query.trim());
    for (i, h) in hits.iter().enumerate() {
        out.push_str(&format!(
            "{}. [{}] {} — {}\n   {}\n",
            i + 1,
            h.timestamp,
            h.title,
            h.meeting_id,
            h.match_context.trim()
        ));
    }
    if hits.is_empty() {
        out.push_str("(no matching transcript snippets)\n");
    }
    out
}

#[tauri::command]
#[specta::specta]
pub async fn api_nl_search_meetings<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<NlSearchResponse, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("Query cannot be empty".to_string());
    }
    let pool = state.db_manager.pool();
    let results = TranscriptsRepository::search_transcripts(pool, &q)
        .await
        .map_err(|e| format!("search failed: {e}"))?;
    // Rank by token overlap so multi-word NL queries still surface useful hits
    // even when the whole phrase is not a contiguous LIKE match.
    let mut hits: Vec<NlSearchHit> = results
        .into_iter()
        .map(|r| NlSearchHit {
            meeting_id: r.id,
            title: r.title,
            match_context: r.match_context,
            timestamp: r.timestamp,
        })
        .collect();
    hits.sort_by(|a, b| {
        hit_rank_key(&b.match_context, &q)
            .cmp(&hit_rank_key(&a.match_context, &q))
            .then_with(|| a.title.cmp(&b.title))
    });
    hits.truncate(MAX_NL_HITS);
    let context_pack = build_context_pack(&q, &hits);
    Ok(NlSearchResponse {
        query: q,
        hits,
        context_pack,
    })
}

/// Score a hit for ranking (pure): prefer denser match context.
pub fn hit_rank_key(context: &str, query: &str) -> i32 {
    let c = context.to_lowercase();
    let q = query.to_lowercase();
    let mut score = 0i32;
    if c.contains(&q) {
        score += 10;
    }
    for word in q.split_whitespace() {
        if c.contains(word) {
            score += 2;
        }
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_includes_query_and_hits() {
        let hits = vec![NlSearchHit {
            meeting_id: "m1".into(),
            title: "Sync".into(),
            match_context: "talked about budget".into(),
            timestamp: "00:01".into(),
        }];
        let pack = build_context_pack("budget", &hits);
        assert!(pack.contains("budget"));
        assert!(pack.contains("Sync"));
        assert!(pack.contains("talked about budget"));
    }

    #[test]
    fn rank_prefers_full_query() {
        assert!(hit_rank_key("the budget plan", "budget") > hit_rank_key("hello", "budget"));
    }
}
