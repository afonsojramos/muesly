/// Keychain abstraction for storing API keys in the OS keychain.
///
/// The `SecretStore` trait is injected into repository methods so tests can
/// use a `MockStore` without touching the real OS keychain.

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// Minimal interface for a secret store.
pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

// ---------------------------------------------------------------------------
// Real keyring store
// ---------------------------------------------------------------------------

/// A zero-sized store backed by the OS keychain via the `keyring` crate.
pub struct KeyringStore;

static KEYRING_STORE: KeyringStore = KeyringStore;

/// Returns a reference to the process-wide `KeyringStore`.
pub fn keyring_store() -> &'static KeyringStore {
    &KEYRING_STORE
}

impl SecretStore for KeyringStore {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new("muesly", key).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new("muesly", key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new("muesly", key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Key-naming helpers
// ---------------------------------------------------------------------------

/// Returns the keychain entry key for a given table and provider.
///
/// `table == "transcript"` produces `"{provider}-transcript-api-key"`;
/// all other tables produce `"{provider}-api-key"`.
/// The special value `"custom-openai"` maps to `"custom-openai-api-key"`.
pub fn entry_key(table: &str, provider: &str) -> String {
    if table == "transcript" {
        format!("{}-transcript-api-key", provider)
    } else {
        format!("{}-api-key", provider)
    }
}

// ---------------------------------------------------------------------------
// Availability probe
// ---------------------------------------------------------------------------

/// Returns `true` if the keychain backend is reachable.
///
/// Stores, retrieves, and deletes a dummy probe value. If any step fails the
/// keychain is considered unavailable.
pub fn check_available(store: &dyn SecretStore) -> bool {
    let probe_key = "__availability_probe__";
    let probe_value = "probe-value-1234";

    if store.set(probe_key, probe_value).is_err() {
        return false;
    }
    match store.get(probe_key) {
        Ok(Some(v)) if v == probe_value => {}
        _ => return false,
    }
    store.delete(probe_key).is_ok()
}

// ---------------------------------------------------------------------------
// Mock store for tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub struct MockStore {
    pub data: std::sync::Mutex<std::collections::HashMap<String, String>>,
    pub fail: bool,
}

#[cfg(test)]
impl MockStore {
    pub fn new() -> Self {
        Self {
            data: std::sync::Mutex::new(std::collections::HashMap::new()),
            fail: false,
        }
    }

    pub fn failing() -> Self {
        Self {
            data: std::sync::Mutex::new(std::collections::HashMap::new()),
            fail: true,
        }
    }
}

#[cfg(test)]
impl SecretStore for MockStore {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if self.fail {
            return Err("MockStore: simulated failure".to_string());
        }
        self.data
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        if self.fail {
            return Err("MockStore: simulated failure".to_string());
        }
        Ok(self.data.lock().unwrap().get(key).cloned())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        if self.fail {
            return Err("MockStore: simulated failure".to_string());
        }
        self.data.lock().unwrap().remove(key);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_and_retrieve_roundtrip() {
        let store = MockStore::new();
        store.set("test-provider-api-key", "test-key-123").unwrap();
        let got = store.get("test-provider-api-key").unwrap();
        assert_eq!(got.as_deref(), Some("test-key-123"));
        store.delete("test-provider-api-key").unwrap();
    }

    #[test]
    fn store_overwrites_existing() {
        let store = MockStore::new();
        store.set("overwrite-key", "value-a").unwrap();
        store.set("overwrite-key", "value-b").unwrap();
        let got = store.get("overwrite-key").unwrap();
        assert_eq!(got.as_deref(), Some("value-b"));
    }

    #[test]
    fn delete_nonexistent_is_ok() {
        let store = MockStore::new();
        let result = store.delete("never-stored-key");
        assert!(result.is_ok(), "delete of absent key must not error");
    }

    #[test]
    fn retrieve_absent_returns_none() {
        let store = MockStore::new();
        let result = store.get("absent-key").unwrap();
        assert!(result.is_none(), "get of absent key must return None");
    }

    #[test]
    fn check_available_passes_with_mock() {
        let store = MockStore::new();
        assert!(check_available(&store));
    }

    #[test]
    fn check_available_fails_with_failing_mock() {
        let store = MockStore::failing();
        assert!(!check_available(&store));
    }

    #[test]
    fn entry_key_settings_table() {
        assert_eq!(entry_key("settings", "openai"), "openai-api-key");
        assert_eq!(entry_key("settings", "groq"), "groq-api-key");
        assert_eq!(
            entry_key("settings", "custom-openai"),
            "custom-openai-api-key"
        );
    }

    #[test]
    fn entry_key_transcript_table() {
        assert_eq!(
            entry_key("transcript", "groq"),
            "groq-transcript-api-key"
        );
        assert_eq!(
            entry_key("transcript", "openai"),
            "openai-transcript-api-key"
        );
    }

    /// Real keychain round-trip — skipped in CI (no Secret Service).
    /// Run with: cargo test --lib keychain -- --ignored
    #[test]
    #[ignore]
    fn real_keyring_roundtrip() {
        let store = KeyringStore;
        let key = "muesly-test-real-roundtrip";
        store.set(key, "test-key-123").unwrap();
        let got = store.get(key).unwrap();
        assert_eq!(got.as_deref(), Some("test-key-123"));
        store.delete(key).unwrap();
        let after = store.get(key).unwrap();
        assert!(after.is_none());
    }
}
