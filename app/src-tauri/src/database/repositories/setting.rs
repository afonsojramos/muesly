use crate::database::models::{Setting, TranscriptSetting};
use crate::keychain::{entry_key, SecretStore};
use crate::summary::CustomOpenAIConfig;
use sqlx::SqlitePool;

#[derive(serde::Deserialize, Debug)]
pub struct SaveModelConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "ollamaEndpoint")]
    pub ollama_endpoint: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
pub struct SaveTranscriptConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

pub struct SettingsRepository;

/// Outcome of a one-time migration run.
pub enum MigrationOutcome {
    /// All keys migrated; `keychainMigrated` set to 1.
    Complete,
    /// One or more keys failed to migrate; flag NOT set. The app retries next launch.
    Partial,
}

// Transcript providers: localWhisper, deepgram, elevenLabs, groq, openai
// Summary providers: openai, claude, ollama, groq, added openrouter
// NOTE: Handle data exclusion in the higher layer as this is database abstraction layer(using SELECT *)

impl SettingsRepository {
    pub async fn get_model_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<Setting>, sqlx::Error> {
        let setting = sqlx::query_as::<_, Setting>("SELECT * FROM settings LIMIT 1")
            .fetch_optional(pool)
            .await?;
        Ok(setting)
    }

    pub async fn save_model_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
        whisper_model: &str,
        ollama_endpoint: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        // Using id '1' for backward compatibility
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, ollamaEndpoint)
            VALUES ('1', $1, $2, $3, $4)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model,
                whisperModel = excluded.whisperModel,
                ollamaEndpoint = excluded.ollamaEndpoint
            "#,
        )
        .bind(provider)
        .bind(model)
        .bind(whisper_model)
        .bind(ollama_endpoint)
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Saves an API key for a summary provider.
    ///
    /// Writes to the keychain and sets the SQLite column to NULL on success.
    /// If the keychain write fails, returns the error so the caller can surface it.
    pub async fn save_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
        store: &dyn SecretStore,
    ) -> std::result::Result<(), String> {
        // Custom OpenAI uses JSON config (customOpenAIConfig) instead of a separate API key column
        if provider == "custom-openai" {
            return Err(
                "custom-openai provider should use save_custom_openai_config() instead of save_api_key()".to_string(),
            );
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "claude" => "anthropicApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "grok" => "xaiApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            _ => return Err(format!("Invalid provider: {}", provider)),
        };

        let key = entry_key("settings", provider);
        store.set(&key, api_key)?;

        // NULL the SQLite column — no plaintext in the database after this point.
        let query = format!(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, "{}")
            VALUES ('1', 'openai', 'gpt-4o-2024-11-20', 'large-v3', NULL)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = NULL
            "#,
            api_key_column, api_key_column
        );
        sqlx::query(&query)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Gets an API key for a summary provider.
    ///
    /// Tries the keychain first; falls back to the SQLite column (dual-read shim).
    pub async fn get_api_key(
        pool: &SqlitePool,
        provider: &str,
        store: &dyn SecretStore,
    ) -> std::result::Result<Option<String>, String> {
        // Custom OpenAI uses JSON config — extract API key from there.
        if provider == "custom-openai" {
            let config = Self::get_custom_openai_config(pool, store)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(config.and_then(|c| c.api_key));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "grok" => "xaiApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(None), // No API key needed
            _ => return Err(format!("Invalid provider: {}", provider)),
        };

        let key = entry_key("settings", provider);
        if let Some(v) = store.get(&key)? {
            return Ok(Some(v));
        }

        // Dual-read shim: fall back to the SQLite column.
        let query = format!(
            "SELECT {} FROM settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key = sqlx::query_scalar(&query)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(api_key)
    }

    pub async fn get_transcript_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<TranscriptSetting>, sqlx::Error> {
        let setting =
            sqlx::query_as::<_, TranscriptSetting>("SELECT * FROM transcript_settings LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(setting)
    }

    pub async fn save_transcript_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO transcript_settings (id, provider, model)
            VALUES ('1', $1, $2)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model
            "#,
        )
        .bind(provider)
        .bind(model)
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Saves an API key for a transcript provider.
    ///
    /// Writes to the keychain and sets the SQLite column to NULL on success.
    pub async fn save_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
        store: &dyn SecretStore,
    ) -> std::result::Result<(), String> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(()), // Parakeet doesn't need an API key, return early
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => return Err(format!("Invalid provider: {}", provider)),
        };

        let key = entry_key("transcript", provider);
        store.set(&key, api_key)?;

        // NULL the SQLite column.
        let query = format!(
            r#"
            INSERT INTO transcript_settings (id, provider, model, "{}")
            VALUES ('1', 'parakeet', '{}', NULL)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = NULL
            "#,
            api_key_column,
            crate::config::DEFAULT_PARAKEET_MODEL,
            api_key_column
        );
        sqlx::query(&query)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Gets an API key for a transcript provider.
    ///
    /// Tries the keychain first; falls back to the SQLite column (dual-read shim).
    pub async fn get_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
        store: &dyn SecretStore,
    ) -> std::result::Result<Option<String>, String> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(None), // Parakeet doesn't need an API key
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => return Err(format!("Invalid provider: {}", provider)),
        };

        let key = entry_key("transcript", provider);
        if let Some(v) = store.get(&key)? {
            return Ok(Some(v));
        }

        // Dual-read shim: fall back to the SQLite column.
        let query = format!(
            "SELECT {} FROM transcript_settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key = sqlx::query_scalar(&query)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(api_key)
    }

    /// Deletes an API key for a summary or transcript provider.
    ///
    /// Removes from the keychain and sets the SQLite column to NULL.
    /// For `custom-openai`, removes the keychain entry and rewrites the JSON blob
    /// with `apiKey` absent, preserving all other fields (ADR open question 5).
    pub async fn delete_api_key(
        pool: &SqlitePool,
        provider: &str,
        store: &dyn SecretStore,
    ) -> std::result::Result<(), String> {
        if provider == "custom-openai" {
            store.delete("custom-openai-api-key")?;
            // Rewrite the JSON blob with apiKey removed, preserving other fields.
            let existing = Self::get_custom_openai_config_raw(pool)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(mut config) = existing {
                config.api_key = None;
                let config_json = serde_json::to_string(&config)
                    .map_err(|e| format!("Failed to serialize config: {}", e))?;
                sqlx::query(
                    "UPDATE settings SET customOpenAIConfig = $1 WHERE id = '1'",
                )
                .bind(config_json)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "grok" => "xaiApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            _ => return Err(format!("Invalid provider: {}", provider)),
        };

        let key = entry_key("settings", provider);
        store.delete(&key)?;

        let query = format!(
            "UPDATE settings SET {} = NULL WHERE id = '1'",
            api_key_column
        );
        sqlx::query(&query)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    // ===== CUSTOM OPENAI CONFIG METHODS =====

    /// Gets the custom OpenAI configuration from JSON, filling `apiKey` from
    /// the keychain when the stored JSON has it as null/absent (dual-read shim).
    pub async fn get_custom_openai_config(
        pool: &SqlitePool,
        store: &dyn SecretStore,
    ) -> std::result::Result<Option<CustomOpenAIConfig>, sqlx::Error> {
        let mut config = match Self::get_custom_openai_config_raw(pool).await? {
            Some(c) => c,
            None => return Ok(None),
        };

        // Dual-read shim: fill api_key from keychain if absent in JSON.
        if config.api_key.is_none() {
            if let Ok(Some(key)) = store.get("custom-openai-api-key") {
                config.api_key = Some(key);
            }
        }

        Ok(Some(config))
    }

    /// Reads the raw JSON config without the keychain lookup.
    async fn get_custom_openai_config_raw(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<CustomOpenAIConfig>, sqlx::Error> {
        use sqlx::Row;

        let row = sqlx::query(
            r#"
            SELECT customOpenAIConfig
            FROM settings
            WHERE id = '1'
            LIMIT 1
            "#,
        )
        .fetch_optional(pool)
        .await?;

        match row {
            Some(record) => {
                let config_json: Option<String> = record.get("customOpenAIConfig");
                if let Some(json) = config_json {
                    let config: CustomOpenAIConfig =
                        serde_json::from_str(&json).map_err(|e| {
                            sqlx::Error::Protocol(
                                format!("Invalid JSON in customOpenAIConfig: {}", e).into(),
                            )
                        })?;
                    Ok(Some(config))
                } else {
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }

    /// Saves the custom OpenAI configuration.
    ///
    /// Extracts `apiKey`, writes it to the keychain, and serializes the blob
    /// with `apiKey` set to null so no plaintext key reaches SQLite.
    pub async fn save_custom_openai_config(
        pool: &SqlitePool,
        config: &CustomOpenAIConfig,
        store: &dyn SecretStore,
    ) -> std::result::Result<(), String> {
        // Store the key in the keychain if present.
        if let Some(ref key_value) = config.api_key {
            if !key_value.is_empty() {
                store.set("custom-openai-api-key", key_value)?;
            }
        }

        // Serialize with apiKey nulled out — no plaintext in SQLite.
        let mut config_for_db = config.clone();
        config_for_db.api_key = None;

        let config_json = serde_json::to_string(&config_for_db)
            .map_err(|e| format!("Failed to serialize config to JSON: {}", e))?;

        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, customOpenAIConfig)
            VALUES ('1', 'custom-openai', $1, 'large-v3', $2)
            ON CONFLICT(id) DO UPDATE SET
                customOpenAIConfig = excluded.customOpenAIConfig
            "#,
        )
        .bind(&config.model)
        .bind(config_json)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    // ===== MIGRATION =====

    /// Moves all non-NULL plaintext API keys to the keychain and NULLs the columns.
    ///
    /// Sets `keychainMigrated = 1` only if every key migrated successfully.
    /// On partial failure the flag stays 0 so the migration retries on next launch.
    pub async fn migrate_keys_to_keychain(
        pool: &SqlitePool,
        store: &dyn SecretStore,
    ) -> std::result::Result<MigrationOutcome, sqlx::Error> {
        let mut any_failed = false;

        // ------------------------------------------------------------------
        // settings table
        // ------------------------------------------------------------------
        let settings_keys: Vec<(&str, &str)> = vec![
            ("openai", "openaiApiKey"),
            ("claude", "anthropicApiKey"),
            ("ollama", "ollamaApiKey"),
            ("groq", "groqApiKey"),
            ("grok", "xaiApiKey"),
            ("openrouter", "openRouterApiKey"),
        ];

        for (provider, column) in &settings_keys {
            let query = format!(
                "SELECT {} FROM settings WHERE id = '1' LIMIT 1",
                column
            );
            let value: Option<Option<String>> =
                sqlx::query_scalar(&query).fetch_optional(pool).await?;
            let value = value.flatten();

            if let Some(v) = value {
                let key = entry_key("settings", provider);
                match store.set(&key, &v) {
                    Ok(()) => {
                        let null_query =
                            format!("UPDATE settings SET {} = NULL WHERE id = '1'", column);
                        if let Err(e) = sqlx::query(&null_query).execute(pool).await {
                            log::error!("Failed to NULL {} after keychain write: {}", column, e);
                            any_failed = true;
                        }
                    }
                    Err(e) => {
                        log::error!(
                            "Keychain write failed for {}: {}; leaving plaintext in place",
                            provider,
                            e
                        );
                        any_failed = true;
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // customOpenAIConfig — extract apiKey from JSON blob
        // ------------------------------------------------------------------
        if let Some(mut config) = Self::get_custom_openai_config_raw(pool).await? {
            if let Some(ref key_value) = config.api_key {
                match store.set("custom-openai-api-key", key_value) {
                    Ok(()) => {
                        config.api_key = None;
                        match serde_json::to_string(&config) {
                            Ok(json) => {
                                if let Err(e) = sqlx::query(
                                    "UPDATE settings SET customOpenAIConfig = $1 WHERE id = '1'",
                                )
                                .bind(json)
                                .execute(pool)
                                .await
                                {
                                    log::error!(
                                        "Failed to update customOpenAIConfig after keychain write: {}",
                                        e
                                    );
                                    any_failed = true;
                                }
                            }
                            Err(e) => {
                                log::error!("Failed to serialize customOpenAIConfig: {}", e);
                                any_failed = true;
                            }
                        }
                    }
                    Err(e) => {
                        log::error!(
                            "Keychain write failed for custom-openai-api-key: {}; leaving plaintext",
                            e
                        );
                        any_failed = true;
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // transcript_settings table
        // ------------------------------------------------------------------
        let transcript_keys: Vec<(&str, &str)> = vec![
            ("localWhisper", "whisperApiKey"),
            ("deepgram", "deepgramApiKey"),
            ("elevenLabs", "elevenLabsApiKey"),
            ("groq", "groqApiKey"),
            ("openai", "openaiApiKey"),
        ];

        for (provider, column) in &transcript_keys {
            let query = format!(
                "SELECT {} FROM transcript_settings WHERE id = '1' LIMIT 1",
                column
            );
            let value: Option<Option<String>> =
                sqlx::query_scalar(&query).fetch_optional(pool).await?;
            let value = value.flatten();

            if let Some(v) = value {
                let key = entry_key("transcript", provider);
                match store.set(&key, &v) {
                    Ok(()) => {
                        let null_query = format!(
                            "UPDATE transcript_settings SET {} = NULL WHERE id = '1'",
                            column
                        );
                        if let Err(e) = sqlx::query(&null_query).execute(pool).await {
                            log::error!(
                                "Failed to NULL transcript {} after keychain write: {}",
                                column,
                                e
                            );
                            any_failed = true;
                        }
                    }
                    Err(e) => {
                        log::error!(
                            "Keychain write failed for transcript {}: {}; leaving plaintext",
                            provider,
                            e
                        );
                        any_failed = true;
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // Set the migration flag only when everything succeeded.
        // ------------------------------------------------------------------
        if !any_failed {
            sqlx::query(
                "UPDATE settings SET keychainMigrated = 1 WHERE id = '1'",
            )
            .execute(pool)
            .await?;
            Ok(MigrationOutcome::Complete)
        } else {
            Ok(MigrationOutcome::Partial)
        }
    }

    // ===== TRANSCRIPTION LANGUAGE =====

    /// Read the persisted transcription language preference, or `None` when it has
    /// never been set (the caller falls back to "auto").
    pub async fn get_transcription_language(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let language: Option<Option<String>> =
            sqlx::query_scalar("SELECT transcriptionLanguage FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(language.flatten())
    }

    /// Persist the transcription language preference on the single settings row,
    /// supplying the same placeholder defaults the other writers use so a
    /// language-only write never violates the NOT NULL columns.
    pub async fn set_transcription_language(
        pool: &SqlitePool,
        language: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, transcriptionLanguage)
            VALUES ('1', 'openai', 'gpt-4o-2024-11-20', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                transcriptionLanguage = excluded.transcriptionLanguage
            "#,
        )
        .bind(language)
        .execute(pool)
        .await?;

        Ok(())
    }

    // ===== CUSTOM VOCABULARY =====

    /// Read the persisted custom vocabulary JSON, or None when never set.
    pub async fn get_custom_vocabulary(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let json: Option<Option<String>> =
            sqlx::query_scalar("SELECT customVocabulary FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(json.flatten())
    }

    /// Persist the custom vocabulary JSON on the single settings row, supplying the
    /// same placeholder defaults the other writers use so a vocabulary-only write
    /// never violates the NOT NULL columns.
    pub async fn set_custom_vocabulary(
        pool: &SqlitePool,
        json: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, customVocabulary)
            VALUES ('1', 'openai', 'gpt-4o-2024-11-20', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                customVocabulary = excluded.customVocabulary
            "#,
        )
        .bind(json)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::MockStore;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Single-connection in-memory pool with all real migrations applied. No mocking.
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

    // -----------------------------------------------------------------------
    // Existing tests — updated to pass a MockStore
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn transcription_language_missing_returns_none() {
        let pool = test_pool().await;
        let lang = SettingsRepository::get_transcription_language(&pool)
            .await
            .expect("query");
        assert!(lang.is_none());
    }

    #[tokio::test]
    async fn set_then_get_transcription_language_roundtrips() {
        let pool = test_pool().await;
        SettingsRepository::set_transcription_language(&pool, "pt")
            .await
            .expect("set");

        let lang = SettingsRepository::get_transcription_language(&pool)
            .await
            .expect("query");
        assert_eq!(lang.as_deref(), Some("pt"));
    }

    #[tokio::test]
    async fn set_transcription_language_overwrites_without_touching_siblings() {
        let pool = test_pool().await;
        let store = MockStore::new();

        // Seed an API key first; the language write must not null it out.
        SettingsRepository::save_api_key(&pool, "openai", "sk-test", &store)
            .await
            .expect("save api key");

        SettingsRepository::set_transcription_language(&pool, "es")
            .await
            .expect("first set");
        SettingsRepository::set_transcription_language(&pool, "fr")
            .await
            .expect("second set");

        let lang = SettingsRepository::get_transcription_language(&pool)
            .await
            .expect("query");
        assert_eq!(lang.as_deref(), Some("fr"));

        // Key is in the store, not the column — get_api_key reads from store first.
        let api_key = SettingsRepository::get_api_key(&pool, "openai", &store)
            .await
            .expect("get api key");
        assert_eq!(api_key.as_deref(), Some("sk-test"));
    }

    #[tokio::test]
    async fn save_and_get_api_key_roundtrip_openai() {
        let pool = test_pool().await;
        let store = MockStore::new();
        SettingsRepository::save_api_key(&pool, "openai", "test-key-123", &store)
            .await
            .expect("save");
        let key = SettingsRepository::get_api_key(&pool, "openai", &store)
            .await
            .expect("get");
        assert_eq!(key.as_deref(), Some("test-key-123"));
    }

    #[tokio::test]
    async fn save_and_get_api_key_roundtrip_claude() {
        let pool = test_pool().await;
        let store = MockStore::new();
        SettingsRepository::save_api_key(&pool, "claude", "test-key-456", &store)
            .await
            .expect("save");
        let key = SettingsRepository::get_api_key(&pool, "claude", &store)
            .await
            .expect("get");
        assert_eq!(key.as_deref(), Some("test-key-456"));
    }

    #[tokio::test]
    async fn save_and_get_api_key_roundtrip_groq() {
        let pool = test_pool().await;
        let store = MockStore::new();
        SettingsRepository::save_api_key(&pool, "groq", "test-key-789", &store)
            .await
            .expect("save");
        let key = SettingsRepository::get_api_key(&pool, "groq", &store)
            .await
            .expect("get");
        assert_eq!(key.as_deref(), Some("test-key-789"));
    }

    #[tokio::test]
    async fn get_api_key_unknown_provider_returns_invalid_provider_error() {
        let pool = test_pool().await;
        let store = MockStore::new();
        let result = SettingsRepository::get_api_key(&pool, "nosuchprovider", &store).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("Invalid provider"),
            "expected 'Invalid provider' in error, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn save_api_key_unknown_provider_returns_invalid_provider_error() {
        let pool = test_pool().await;
        let store = MockStore::new();
        let result =
            SettingsRepository::save_api_key(&pool, "notreal", "test-key-000", &store).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("Invalid provider"),
            "expected 'Invalid provider' in error, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn save_api_key_custom_openai_returns_protocol_error() {
        let pool = test_pool().await;
        let store = MockStore::new();
        // custom-openai must use save_custom_openai_config, not save_api_key.
        let result =
            SettingsRepository::save_api_key(&pool, "custom-openai", "test-key-000", &store).await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("custom-openai"),
            "expected custom-openai mention in error, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn get_api_key_builtin_ai_returns_none() {
        let pool = test_pool().await;
        let store = MockStore::new();
        let key = SettingsRepository::get_api_key(&pool, "builtin-ai", &store)
            .await
            .expect("no error for builtin-ai");
        assert!(key.is_none(), "builtin-ai never has an API key");
    }

    #[tokio::test]
    async fn overwriting_api_key_returns_updated_value() {
        let pool = test_pool().await;
        let store = MockStore::new();
        SettingsRepository::save_api_key(&pool, "openrouter", "test-key-old", &store)
            .await
            .expect("first save");
        SettingsRepository::save_api_key(&pool, "openrouter", "test-key-new", &store)
            .await
            .expect("second save");
        let key = SettingsRepository::get_api_key(&pool, "openrouter", &store)
            .await
            .expect("get");
        assert_eq!(key.as_deref(), Some("test-key-new"));
    }

    #[tokio::test]
    async fn custom_vocabulary_missing_returns_none() {
        let pool = test_pool().await;
        let vocab = SettingsRepository::get_custom_vocabulary(&pool)
            .await
            .expect("query");
        assert!(vocab.is_none());
    }

    #[tokio::test]
    async fn set_then_get_custom_vocabulary_roundtrips() {
        let pool = test_pool().await;
        let json = r#"[{"from":"cubernetes","to":"Kubernetes"}]"#;
        SettingsRepository::set_custom_vocabulary(&pool, json)
            .await
            .expect("set");
        let result = SettingsRepository::get_custom_vocabulary(&pool)
            .await
            .expect("query");
        assert_eq!(result.as_deref(), Some(json));
    }

    #[tokio::test]
    async fn set_custom_vocabulary_does_not_null_sibling_api_key() {
        let pool = test_pool().await;
        let store = MockStore::new();
        SettingsRepository::save_api_key(&pool, "openai", "sk-test", &store)
            .await
            .expect("save api key");

        let json = r#"[{"from":"muesli","to":"muesly"}]"#;
        SettingsRepository::set_custom_vocabulary(&pool, json)
            .await
            .expect("set vocabulary");

        let key = SettingsRepository::get_api_key(&pool, "openai", &store)
            .await
            .expect("get api key");
        assert_eq!(key.as_deref(), Some("sk-test"));
    }

    // -----------------------------------------------------------------------
    // Phase 3 migration / dual-read tests
    // -----------------------------------------------------------------------

    /// Helper: seed a plaintext key directly into the SQLite column, bypassing keychain.
    async fn seed_plaintext_api_key(pool: &SqlitePool, column: &str, value: &str) {
        let query = format!(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, "{}")
            VALUES ('1', 'openai', 'gpt-4o-2024-11-20', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET "{}" = $1
            "#,
            column, column
        );
        sqlx::query(&query)
            .bind(value)
            .execute(pool)
            .await
            .expect("seed plaintext key");
    }

    #[tokio::test]
    async fn migration_moves_key_and_clears_column() {
        let pool = test_pool().await;
        let store = MockStore::new();

        seed_plaintext_api_key(&pool, "openaiApiKey", "test-key-123").await;

        let outcome = SettingsRepository::migrate_keys_to_keychain(&pool, &store)
            .await
            .expect("migrate");

        assert!(
            matches!(outcome, MigrationOutcome::Complete),
            "expected Complete migration"
        );

        // Keychain received the value under the correct entry key.
        let stored = store
            .data
            .lock()
            .unwrap()
            .get("openai-api-key")
            .cloned();
        assert_eq!(stored.as_deref(), Some("test-key-123"));

        // SQLite column is NULL.
        let col: Option<Option<String>> =
            sqlx::query_scalar("SELECT openaiApiKey FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(&pool)
                .await
                .expect("select");
        assert!(
            col.flatten().is_none(),
            "openaiApiKey must be NULL after migration"
        );

        // keychainMigrated flag is set.
        let flag: Option<i64> =
            sqlx::query_scalar("SELECT keychainMigrated FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(&pool)
                .await
                .expect("select flag");
        assert_eq!(flag, Some(1));
    }

    #[tokio::test]
    async fn migration_retries_on_keychain_failure() {
        let pool = test_pool().await;

        seed_plaintext_api_key(&pool, "openaiApiKey", "test-key-456").await;

        // First pass: keychain fails.
        let failing = MockStore::failing();
        let outcome = SettingsRepository::migrate_keys_to_keychain(&pool, &failing)
            .await
            .expect("migrate with failure");
        assert!(
            matches!(outcome, MigrationOutcome::Partial),
            "expected Partial on keychain failure"
        );

        // Column still non-NULL, flag still 0.
        let col: Option<Option<String>> =
            sqlx::query_scalar("SELECT openaiApiKey FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(&pool)
                .await
                .expect("select");
        assert_eq!(
            col.flatten().as_deref(),
            Some("test-key-456"),
            "column must remain non-NULL after failed migration"
        );
        let flag: Option<i64> =
            sqlx::query_scalar("SELECT keychainMigrated FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(&pool)
                .await
                .expect("select flag");
        assert_eq!(flag, Some(0), "flag must remain 0 after failed migration");

        // Second pass: keychain works.
        let working = MockStore::new();
        let outcome2 = SettingsRepository::migrate_keys_to_keychain(&pool, &working)
            .await
            .expect("retry migrate");
        assert!(
            matches!(outcome2, MigrationOutcome::Complete),
            "expected Complete on retry"
        );
        let flag2: Option<i64> =
            sqlx::query_scalar("SELECT keychainMigrated FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(&pool)
                .await
                .expect("select flag");
        assert_eq!(flag2, Some(1), "flag must be 1 after successful retry");
    }

    #[tokio::test]
    async fn migration_handles_custom_openai_apikey() {
        let pool = test_pool().await;
        let store = MockStore::new();

        // Seed a customOpenAIConfig JSON with an apiKey field.
        let config = CustomOpenAIConfig {
            endpoint: "https://example.com".to_string(),
            api_key: Some("test-key-789".to_string()),
            model: "gpt-4".to_string(),
            max_tokens: None,
            temperature: None,
            top_p: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, customOpenAIConfig)
            VALUES ('1', 'custom-openai', 'gpt-4', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET customOpenAIConfig = $1
            "#,
        )
        .bind(&json)
        .execute(&pool)
        .await
        .expect("seed custom openai config");

        SettingsRepository::migrate_keys_to_keychain(&pool, &store)
            .await
            .expect("migrate");

        // Keychain received the key under the correct entry.
        let stored = store
            .data
            .lock()
            .unwrap()
            .get("custom-openai-api-key")
            .cloned();
        assert_eq!(stored.as_deref(), Some("test-key-789"));

        // Stored JSON has apiKey absent/null.
        let raw = SettingsRepository::get_custom_openai_config_raw(&pool)
            .await
            .expect("get raw");
        assert!(
            raw.and_then(|c| c.api_key).is_none(),
            "apiKey must be null in JSON after migration"
        );
    }

    #[tokio::test]
    async fn dual_read_path_prefers_keychain() {
        let pool = test_pool().await;
        let store = MockStore::new();

        // Put a key in BOTH the keychain and the SQLite column (partial migration state).
        store.set("openai-api-key", "keychain-value").unwrap();
        seed_plaintext_api_key(&pool, "openaiApiKey", "sqlite-value").await;

        let key = SettingsRepository::get_api_key(&pool, "openai", &store)
            .await
            .expect("get");

        assert_eq!(
            key.as_deref(),
            Some("keychain-value"),
            "keychain value must take priority"
        );
    }

    #[tokio::test]
    async fn dual_read_path_falls_back_to_sqlite() {
        let pool = test_pool().await;
        let store = MockStore::new(); // empty — no keychain entry

        seed_plaintext_api_key(&pool, "openaiApiKey", "sqlite-only-value").await;

        let key = SettingsRepository::get_api_key(&pool, "openai", &store)
            .await
            .expect("get");

        assert_eq!(
            key.as_deref(),
            Some("sqlite-only-value"),
            "must fall back to SQLite when keychain has no entry"
        );
    }
}
