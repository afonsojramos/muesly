//! A raw JSON value at a Tauri command boundary.
//!
//! Serializes transparently, so the wire format is identical to
//! `serde_json::Value`, but it is exported to TypeScript as `any`.
//! specta-typescript cannot represent `serde_json::Value` directly: it inlines
//! the recursive type and overflows the stack while formatting. Wrapping the
//! value lets the type-safe bindings generate.
//!
//! This is a transitional escape hatch. Prefer giving a command a concrete typed
//! return struct; reach for `Json` only where a response is genuinely dynamic,
//! and tighten `any` into a real type over time.

/// Transparent wrapper around [`serde_json::Value`] that exports to TS as `any`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Json(pub serde_json::Value);

impl From<serde_json::Value> for Json {
    fn from(value: serde_json::Value) -> Self {
        Json(value)
    }
}

impl specta::Type for Json {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        // Reuse specta-typescript's `any` representation, which is a leaf and so
        // sidesteps the recursive inlining that `serde_json::Value` triggers.
        <specta_typescript::Any as specta::Type>::definition(types)
    }
}
