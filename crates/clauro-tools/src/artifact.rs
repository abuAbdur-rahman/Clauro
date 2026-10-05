//! The `artifact` tool: versioned sources for the drawer (D1).
//!
//! Our schema, no fence to detect and no first-party format to verify:
//! `{title, mediaType, source}` plus an optional `artifactId` naming the
//! artifact to refresh — absent means a new one. (The "classifier" the
//! contract mentions is this validation: only conforming calls reach the
//! drawer.) One live artifact per `(thread, artifact_id)`; refresh commits a
//! new version row, history rows stay. Renderable media only: HTML and SVG.

use crate::registry::Registry;
use clauro_core::{ToolContext, ToolOutcome};
use clauro_store::Store;
use serde_json::Value;
use std::fmt;
use std::sync::Arc;

/// Source cap, in bytes. The compiled cap is 014's; this bounds what the
/// model may hand us.
pub const ARTIFACT_MAX_SOURCE_BYTES: usize = 256 * 1024;

/// Media the frame can render. Exactly HTML and SVG — nothing else reaches
/// the drawer in v1.
fn media_allowed(media_type: &str) -> bool {
    matches!(media_type, "text/html" | "image/svg+xml")
}

/// Why an artifact call failed. Typed, never thrown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactError {
    BadInput(String),
    TooBig(usize),
    Io(String),
}

impl fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadInput(m) => write!(f, "bad input: {m}"),
            Self::TooBig(n) => write!(f, "source over cap ({n} bytes)"),
            Self::Io(m) => write!(f, "artifact unwritable: {m}"),
        }
    }
}

impl std::error::Error for ArtifactError {}

/// What the drawer shows for a fresh or refreshed artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactMeta {
    pub id: String,
    pub version: i64,
    pub title: String,
}

/// Validate and persist one artifact call. Pure apart from the store and the
/// source file it writes.
pub fn create_artifact(
    store: &Store,
    session_root: &std::path::Path,
    thread_id: &str,
    input: &Value,
) -> Result<ArtifactMeta, ArtifactError> {
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| ArtifactError::BadInput("artifact needs a title".to_string()))?;
    let media_type = input.get("mediaType").and_then(Value::as_str).unwrap_or("");
    if !media_allowed(media_type) {
        return Err(ArtifactError::BadInput(format!(
            "renderable media only (text/html, image/svg+xml): {media_type}"
        )));
    }
    let source = input.get("source").and_then(Value::as_str).unwrap_or("");
    if source.is_empty() {
        return Err(ArtifactError::BadInput(
            "artifact needs a source".to_string(),
        ));
    }
    if source.len() > ARTIFACT_MAX_SOURCE_BYTES {
        return Err(ArtifactError::TooBig(source.len()));
    }
    let id = input
        .get("artifactId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Store::new_id("art"));
    let version = store
        .max_artifact_version(thread_id, &id)
        .map(|v| v + 1)
        .unwrap_or(1);
    let dir = session_root
        .join("artifacts")
        .join(format!("{id}-{version}"));
    std::fs::create_dir_all(&dir)
        .map_err(|e| ArtifactError::Io(format!("cannot create dir: {e}")))?;
    std::fs::write(dir.join("source"), source)
        .map_err(|e| ArtifactError::Io(format!("cannot write source: {e}")))?;
    store
        .insert_artifact_version(
            &clauro_store::NewArtifact {
                id: id.clone(),
                thread_id: thread_id.to_string(),
                title: title.to_string(),
                media_type: media_type.to_string(),
                source_path: format!("artifacts/{id}-{version}/source"),
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            },
            version,
        )
        .map_err(|e| ArtifactError::Io(format!("artifact row failed: {e}")))?;
    Ok(ArtifactMeta {
        id,
        version,
        title: title.to_string(),
    })
}

/// Bind the `artifact` handler onto a session-scoped host.
pub fn register_artifact(reg: &mut Registry, host: Arc<crate::FsHost>) {
    let _ = reg.set_handler("artifact", move |input: &Value, ctx: &ToolContext| {
        let store_guard = host.store_handle();
        let store = store_guard.lock().expect("store lock must hold");
        match create_artifact(&store, host.session_root(), &ctx.thread_id, input) {
            Ok(meta) => ToolOutcome::Ok {
                preview: format!("artifact {} v{}", meta.title, meta.version),
                preview_path: None,
                full_path: None,
            },
            Err(e) => ToolOutcome::Error {
                message: e.to_string(),
            },
        }
    });
}
