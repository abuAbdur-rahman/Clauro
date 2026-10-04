//! Output bounding on the way out (D27).
//!
//! Full output goes to a file; the transcript gets a bounded preview plus a
//! path the model can re-read. Bounding happens here, at the return boundary
//! — never at write time, where truncation loses data permanently.

use std::fmt;
use std::path::{Path, PathBuf};

/// Preview cap, in characters. The full text is always stored whole; only the
/// inline slice is bounded.
pub const PREVIEW_LIMIT_CHARS: usize = 8 * 1024;

/// What the transcript keeps: a bounded inline slice plus two re-readable
/// paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedOutput {
    pub preview: String,
    pub preview_path: PathBuf,
    pub full_path: PathBuf,
}

/// Why bounding failed. Filesystem trouble, typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundingError(pub String);

impl fmt::Display for BoundingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "output bounding failed: {}", self.0)
    }
}

impl std::error::Error for BoundingError {}

fn safe_stem(call_id: &str) -> String {
    let stem: String = call_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if stem.is_empty() {
        "call".to_string()
    } else {
        stem
    }
}

/// Store `full_text` whole and return the bounded view. The preview cut never
/// splits a codepoint: it backs up to the last char boundary at or under the
/// cap.
pub fn bound_output(
    workspace_dir: &Path,
    tool_call_id: &str,
    full_text: &str,
) -> Result<BoundedOutput, BoundingError> {
    let stem = safe_stem(tool_call_id);
    let full_path = workspace_dir.join(format!("{stem}.full.txt"));
    let preview_path = workspace_dir.join(format!("{stem}.preview.txt"));
    std::fs::write(&full_path, full_text)
        .map_err(|e| BoundingError(format!("full output unwritable: {e}")))?;
    let mut end = full_text.len().min(
        full_text
            .char_indices()
            .take(PREVIEW_LIMIT_CHARS)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0),
    );
    while !full_text.is_char_boundary(end) {
        end -= 1;
    }
    let preview = full_text[..end].to_string();
    std::fs::write(&preview_path, &preview)
        .map_err(|e| BoundingError(format!("preview unwritable: {e}")))?;
    Ok(BoundedOutput {
        preview,
        preview_path,
        full_path,
    })
}
