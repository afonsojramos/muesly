//! Build safe FTS5 MATCH queries from user text.

/// Tokens suitable for FTS5: alphanumeric / underscore, length >= 2.
pub fn fts_tokens(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .map(str::trim)
        .filter(|t| t.chars().count() >= 2)
        .take(8)
        .map(|t| t.to_lowercase())
        .collect()
}

/// Escape a token for FTS5 double-quoted phrase (strip quotes).
pub fn fts_quote_token(token: &str) -> String {
    let cleaned: String = token.chars().filter(|c| *c != '"').collect();
    format!("\"{cleaned}\"")
}

/// Build an FTS5 MATCH expression: "token1"* OR "token2"* OR ...
/// Prefix queries catch partial words ("budg" hits "budget"), which keeps the
/// LIKE fallback for the rare infix-only case. Returns None if no usable tokens.
pub fn build_fts_match_query(query: &str) -> Option<String> {
    let tokens = fts_tokens(query);
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|t| format!("{}*", fts_quote_token(t)))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_word_or_query() {
        let q = build_fts_match_query("budget launch date").unwrap();
        assert!(q.contains("budget"));
        assert!(q.contains(" OR "));
        assert!(q.contains("launch"));
    }

    #[test]
    fn tokens_are_prefix_queries() {
        let q = build_fts_match_query("budget launch").unwrap();
        assert_eq!(q, "\"budget\"* OR \"launch\"*");
    }

    #[test]
    fn strips_specials() {
        let q = build_fts_match_query("hello!!!").unwrap();
        assert_eq!(q, "\"hello\"*");
    }

    #[test]
    fn empty_returns_none() {
        assert!(build_fts_match_query("a").is_none());
        assert!(build_fts_match_query("").is_none());
    }
}
