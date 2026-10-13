//! The `fs` tool: a Clauro-owned tree, host-enforced rules (D31–D34, D79).
//!
//! Reads span the session workspace and the project directory; writes and
//! edits stay inside the session workspace. Read-before-edit is host state:
//! `edit` fails unless the canonical path was read this session (D33) — a
//! prompt is advisory, every rule here is Rust. Path safety order is
//! load-bearing: canonicalise, resolve symlinks, **then** check (D34).
//!
//! Attachments copy in (never reference) via `ingest_local_file`; dedupe is
//! per project and the model sees path + size + media type only (D47, D52).
//! A reserved device name uploads renamed, not rejected (D79). Writes stage
//! inside `dirname(target)` and `%TEMP%` never sees the bytes (D34). A NEW
//! file inherits the destination directory's DACL; an EXISTING target keeps
//! its own DACL, attributes and named streams across the swap — on Windows
//! that swap is `ReplaceFileW`, because rename-over cannot express it (D128).

use crate::registry::Registry;
#[cfg(windows)]
mod replace;
use clauro_core::{ToolContext, ToolOutcome};
use clauro_store::Store;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Default read window, in lines. Behaviour borrowed, wording ours (D39).
pub const READ_DEFAULT_LINES: usize = 2000;
/// Per-line truncation, in characters.
pub const READ_TRUNCATE_CHARS: usize = 2000;
const LIST_CAP: usize = 1000;
const GLOB_CAP: usize = 500;
const GREP_CAP: usize = 200;

/// Why an `fs` call failed. Typed, never thrown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    BadInput(String),
    OutsideWorkspace(String),
    NotText(String),
    NotRead(String),
    NoMatch(String),
    Ambiguous(String),
    Io(String),
    /// The final swap of a staged write failed. The payload is the captured
    /// `std::io::Error::last_os_error()` from the swap — on Windows the
    /// `ReplaceFileW` code (1175/1176/1177 …), elsewhere the rename errno —
    /// so the Win32/os code reaches the tool boundary intact (D128, D55).
    Replace(String),
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadInput(m) => write!(f, "bad input: {m}"),
            Self::OutsideWorkspace(p) => write!(f, "outside the workspace: {p}"),
            Self::NotText(p) => write!(f, "not readable as text: {p}"),
            Self::NotRead(p) => write!(f, "read the file first, this session: {p}"),
            Self::NoMatch(m) => write!(f, "no match: {m}"),
            Self::Ambiguous(m) => write!(f, "ambiguous, pass replace_all: {m}"),
            Self::Io(m) => write!(f, "filesystem error: {m}"),
            Self::Replace(m) => write!(f, "replace failed: {m}"),
        }
    }
}

impl std::error::Error for FsError {}

/// Session-scoped host: canonical roots, the read set, and the store handle
/// for attachment rows. One per session; shared with the bound handler.
pub struct FsHost {
    session_root: PathBuf,
    project_root: PathBuf,
    project_id: Option<String>,
    read_set: Mutex<HashSet<PathBuf>>,
    store: Arc<Mutex<Store>>,
}

impl FsHost {
    /// Canonicalise both roots up front so every later check compares real
    /// paths, never lexical ones.
    pub fn new(
        session_root: &Path,
        project_root: &Path,
        project_id: Option<String>,
        store: Arc<Mutex<Store>>,
    ) -> Result<Self, FsError> {
        Ok(Self {
            session_root: session_root
                .canonicalize()
                .map_err(|e| FsError::Io(format!("session root unreadable: {e}")))?,
            project_root: project_root
                .canonicalize()
                .map_err(|e| FsError::Io(format!("project root unreadable: {e}")))?,
            project_id,
            read_set: Mutex::new(HashSet::new()),
            store,
        })
    }

    fn resolve_session(&self, user: &str) -> Result<PathBuf, FsError> {
        clauro_fs::resolve_in_workspace(&self.session_root, user)
            .map_err(|e| FsError::OutsideWorkspace(format!("{user}: {e}")))
    }

    fn resolve_project(&self, user: &str) -> Result<PathBuf, FsError> {
        clauro_fs::resolve_in_workspace(&self.project_root, user)
            .map_err(|e| FsError::OutsideWorkspace(format!("{user}: {e}")))
    }

    /// Session root first, project dir second. Write paths use
    /// `resolve_session` directly — the project dir is read-only.
    fn resolve_read(&self, user: &str, scope: &str) -> Result<(PathBuf, bool), FsError> {
        match scope {
            "project" => self.resolve_project(user).map(|p| (p, false)),
            _ => {
                if let Ok(p) = self.resolve_session(user) {
                    return Ok((p, true));
                }
                self.resolve_project(user).map(|p| (p, false))
            }
        }
    }

    /// The read set is per-session in-memory state; a poisoned mutex (only
    /// reachable if an earlier handler panicked mid-hold) is reported as a
    /// typed retryable error instead of panicking across the tool boundary
    /// (D55, audit 10 NIT).
    fn mark_read(&self, canonical: &Path) -> Result<(), FsError> {
        self.read_set
            .lock()
            .map(|mut set| {
                set.insert(canonical.to_path_buf());
            })
            .map_err(|_| FsError::Io("read set busy, retry the call".to_string()))
    }

    fn was_read(&self, canonical: &Path) -> Result<bool, FsError> {
        self.read_set
            .lock()
            .map(|set| set.contains(canonical))
            .map_err(|_| FsError::Io("read set busy, retry the call".to_string()))
    }

    fn read_cmd(&self, input: &Value) -> Result<String, FsError> {
        let user = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| FsError::BadInput("read needs a path".to_string()))?;
        let scope = input
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("session");
        let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(READ_DEFAULT_LINES as u64) as usize;
        let (path, _) = self.resolve_read(user, scope)?;
        // Windowed read (audit 10 NIT): stream only the requested window.
        // The old whole-file load made a multi-GB path a heap DoS before any
        // limit applied, and demanded the ENTIRE file be valid UTF-8 even
        // for a three-line window at the top.
        let file = std::fs::File::open(&path).map_err(|_| FsError::NotText(user.to_string()))?;
        let mut out = String::new();
        for (i, line) in std::io::BufReader::new(file)
            .lines()
            .skip(offset)
            .take(limit)
            .enumerate()
        {
            let line = line.map_err(|_| FsError::NotText(user.to_string()))?;
            let short: String = line.chars().take(READ_TRUNCATE_CHARS).collect();
            out.push_str(&format!("{}: {short}\n", offset + i + 1));
        }
        self.mark_read(&path)?;
        Ok(out)
    }

    fn list_cmd(&self, input: &Value) -> Result<String, FsError> {
        let user = input.get("path").and_then(Value::as_str).unwrap_or(".");
        let scope = input
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("session");
        let (dir, _) = self.resolve_read(user, scope)?;
        if !dir.is_dir() {
            return Err(FsError::BadInput(format!("not a directory: {user}")));
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|e| FsError::Io(e.to_string()))?
            .filter_map(|e| e.ok())
            .map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if e.path().is_dir() {
                    format!("{name}/")
                } else {
                    name
                }
            })
            .collect();
        names.sort();
        names.truncate(LIST_CAP);
        Ok(names.join("\n"))
    }

    /// Breadth-first walk of every regular file under `root`.
    ///
    /// Containment is decided on the **canonical** target, not the link
    /// (D34): `path.is_dir()` follows a junction/symlink, so a link planted
    /// in the workspace pointing at `C:\` or `/etc` would otherwise pull the
    /// always-on grep/glob into an out-of-tree read oracle. A canonical
    /// `HashSet` doubles as the visited set, so a link cycle terminates
    /// instead of walking forever.
    fn walk_files(&self, root: &Path, out: &mut Vec<PathBuf>) {
        let Ok(root_canon) = root.canonicalize() else {
            return;
        };
        let mut stack = vec![root.to_path_buf()];
        let mut seen = std::collections::HashSet::new();
        seen.insert(root_canon.clone());
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    let Ok(canon) = path.canonicalize() else {
                        continue; // broken/denied link: skipped, never followed
                    };
                    // Under root, and not a cycle already walked.
                    if canon.starts_with(&root_canon) && seen.insert(canon) {
                        stack.push(path);
                    }
                } else if out.len() < GLOB_CAP {
                    out.push(path);
                }
            }
        }
    }

    fn glob_match(pattern: &str, path: &str) -> bool {
        fn seg(p: &[u8], s: &[u8]) -> bool {
            if p.is_empty() {
                return s.is_empty();
            }
            if p[0] == b'*' {
                return (0..=s.len()).any(|i| seg(&p[1..], &s[i..]));
            }
            if s.is_empty() {
                return false;
            }
            if p[0] == b'?' || p[0] == s[0] {
                return seg(&p[1..], &s[1..]);
            }
            false
        }
        // `**` crosses separators; anything else matches one segment, with
        // backtracking over how many segments `**` swallows.
        let p: Vec<&str> = pattern.split('/').collect();
        let s: Vec<&str> = path.split('/').collect();
        let mut states = vec![(0usize, 0usize)];
        let mut seen = std::collections::HashSet::new();
        while let Some((pi, si)) = states.pop() {
            if !seen.insert((pi, si)) {
                continue;
            }
            if pi == p.len() && si == s.len() {
                return true;
            }
            if pi < p.len() && p[pi] == "**" {
                states.push((pi + 1, si));
                if si < s.len() {
                    states.push((pi, si + 1));
                }
                continue;
            }
            if pi < p.len() && si < s.len() && seg(p[pi].as_bytes(), s[si].as_bytes()) {
                states.push((pi + 1, si + 1));
            }
        }
        false
    }

    fn glob_cmd(&self, input: &Value) -> Result<String, FsError> {
        let pattern = input
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| FsError::BadInput("glob needs a pattern".to_string()))?;
        let scope = input
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("session");
        let (root, _) = match scope {
            "project" => (self.project_root.clone(), false),
            _ => (self.session_root.clone(), true),
        };
        // The pattern itself must be traversal-free; matches stay under root
        // by construction (walked, never joined from input).
        if pattern.split('/').any(|s| s == "..") || clauro_fs::is_reserved_file_name(pattern) {
            return Err(FsError::OutsideWorkspace(pattern.to_string()));
        }
        let mut files = Vec::new();
        self.walk_files(&root, &mut files);
        let mut hits: Vec<String> = files
            .iter()
            .filter_map(|p| p.strip_prefix(&root).ok())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .filter(|rel| Self::glob_match(pattern, rel))
            .collect();
        hits.sort();
        hits.truncate(GLOB_CAP);
        Ok(hits.join("\n"))
    }

    fn grep_cmd(&self, input: &Value) -> Result<String, FsError> {
        let needle = input
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| FsError::BadInput("grep needs a pattern".to_string()))?;
        if needle.is_empty() {
            return Err(FsError::BadInput(
                "grep pattern must not be empty".to_string(),
            ));
        }
        let scope = input
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("session");
        let (root, _) = match scope {
            "project" => (self.project_root.clone(), false),
            _ => (self.session_root.clone(), true),
        };
        let mut files = Vec::new();
        self.walk_files(&root, &mut files);
        files.sort();
        let mut hits = Vec::new();
        for path in files {
            let Ok(bytes) = std::fs::read(&path) else {
                continue; // binary or unreadable: skipped, never errored
            };
            let Ok(text) = String::from_utf8(bytes) else {
                continue;
            };
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            for (i, line) in text.lines().enumerate() {
                if line.contains(needle) {
                    let short: String = line.chars().take(500).collect();
                    hits.push(format!("{rel}:{}: {short}", i + 1));
                    if hits.len() >= GREP_CAP {
                        break;
                    }
                }
            }
            if hits.len() >= GREP_CAP {
                break;
            }
        }
        Ok(hits.join("\n"))
    }

    /// Staged write: temp file beside the target, fsync, then swap. `%TEMP%`
    /// never sees the bytes (D34); a new target inherits the destination
    /// directory's DACL, an existing one keeps its own DACL, attributes and
    /// named streams — on Windows the swap is `ReplaceFileW` (D128, audit 11).
    /// Bytes in, so ingest and write share this one path (audit 11 NIT:
    /// ingest used to bypass staging entirely).
    fn stage_write(&self, target: &Path, content: &[u8]) -> Result<(), FsError> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| FsError::Io(format!("cannot create dir: {e}")))?;
        }
        let dir = target
            .parent()
            .ok_or_else(|| FsError::BadInput("no parent".to_string()))?;
        // Sweep leftovers of crashed runs (audit 11 NIT): a `.tmp-*` file
        // beside the target is never security state and never referenced —
        // the staging name is fresh per write — so removal is best-effort; a
        // failure is retried by every later write into this directory.
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with(".tmp-") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let tmp = dir.join(format!(
            ".tmp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let write_out = (|| -> std::io::Result<()> {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(content)?;
            // Durability before the swap (audit 11 NIT): the rename is the
            // commit point (D34), so the bytes must be on disk BEFORE it —
            // otherwise a crash can leave a fresh name over an empty or
            // half-written file.
            f.sync_all()
        })();
        if let Err(e) = write_out {
            let _ = std::fs::remove_file(&tmp);
            return Err(FsError::Io(format!("staging failed: {e}")));
        }
        // The swap. Over an EXISTING target on Windows: `ReplaceFileW`, which
        // merges security from the replaced file — the target keeps its DACL,
        // attributes, owner and named streams (D34, D128). Plain rename here
        // would be MoveFileExW(MOVEFILE_REPLACE_EXISTING): the survivor
        // carries the staged file's directory-inherited descriptor and the
        // target's explicit one dies with it. A target that does not exist
        // has no security state to preserve (and ReplaceFileW requires one),
        // so that path stays a plain rename, as before.
        #[cfg(windows)]
        let swap = if target.exists() {
            replace::replace_preserving(target, &tmp)
        } else {
            std::fs::rename(&tmp, target)
        };
        #[cfg(not(windows))]
        let swap = std::fs::rename(&tmp, target);
        if let Err(e) = swap {
            // Cleanup is guarded (D128): sweep the staged file only when the
            // target survived — ReplaceFileW's ERROR_UNABLE_TO_MOVE_REPLACEMENT
            // (1176) leaves the target gone and the staged bytes under their
            // temp name, and deleting those would destroy the only remaining
            // copy — so in that state they move into place instead. Either
            // way a typed error carries the captured last_os_error back and
            // nothing throws across the tool boundary (D55).
            let _ = if target.exists() {
                std::fs::remove_file(&tmp)
            } else {
                std::fs::rename(&tmp, target)
            };
            return Err(FsError::Replace(e.to_string()));
        }
        Ok(())
    }

    fn write_cmd(&self, input: &Value) -> Result<String, FsError> {
        let scope = input
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("session");
        if scope == "project" {
            return Err(FsError::OutsideWorkspace(
                "the project directory is read-only; write inside the session workspace"
                    .to_string(),
            ));
        }
        let user = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| FsError::BadInput("write needs a path".to_string()))?;
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| FsError::BadInput("write needs content".to_string()))?;
        let target = self.resolve_session(user)?;
        self.stage_write(&target, content.as_bytes())?;
        Ok(format!("wrote {} bytes to {user}", content.len()))
    }

    fn edit_cmd(&self, input: &Value) -> Result<String, FsError> {
        let scope = input
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("session");
        if scope == "project" {
            return Err(FsError::OutsideWorkspace(
                "the project directory is read-only; edit inside the session workspace".to_string(),
            ));
        }
        let user = input
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| FsError::BadInput("edit needs a path".to_string()))?;
        let target = self.resolve_session(user)?;
        if !self.was_read(&target)? {
            return Err(FsError::NotRead(user.to_string()));
        }
        let old = input
            .get("old_string")
            .and_then(Value::as_str)
            .ok_or_else(|| FsError::BadInput("edit needs old_string".to_string()))?;
        if old.is_empty() {
            return Err(FsError::BadInput(
                "old_string must not be empty".to_string(),
            ));
        }
        let new = input
            .get("new_string")
            .and_then(Value::as_str)
            .unwrap_or("");
        let replace_all = input
            .get("replace_all")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let text = std::fs::read(&target)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or_else(|| FsError::NotText(user.to_string()))?;
        let count = text.matches(old).count();
        if count == 0 {
            return Err(FsError::NoMatch(format!("{old:?} not found in {user}")));
        }
        if count > 1 && !replace_all {
            return Err(FsError::Ambiguous(format!(
                "{count} matches in {user}; pass replace_all"
            )));
        }
        let updated = text.replacen(old, new, if replace_all { count } else { 1 });
        self.stage_write(&target, updated.as_bytes())?;
        Ok(format!("replaced {count} occurrence(s) in {user}"))
    }

    fn dispatch_cmd(&self, input: &Value) -> Result<String, FsError> {
        match input.get("command").and_then(Value::as_str) {
            Some("read") => self.read_cmd(input),
            Some("list") => self.list_cmd(input),
            Some("glob") => self.glob_cmd(input),
            Some("grep") => self.grep_cmd(input),
            Some("write") => self.write_cmd(input),
            Some("edit") => self.edit_cmd(input),
            Some(other) => Err(FsError::BadInput(format!("unknown command: {other}"))),
            None => Err(FsError::BadInput("fs needs a command".to_string())),
        }
    }

    /// Copy a host file into the session workspace. Never references the
    /// original: the bytes are copied, the source untouched. Dedupe is per
    /// project on the content hash (D52); the model receives path + size +
    /// media type only, never the bytes inline (D47). Reserved device names
    /// upload renamed, not rejected (D79).
    pub fn ingest_local_file(
        &self,
        src: &Path,
        file_name: &str,
    ) -> Result<AttachmentMeta, FsError> {
        if !src.is_file() {
            return Err(FsError::BadInput(format!(
                "no such file: {}",
                src.display()
            )));
        }
        let bytes = std::fs::read(src).map_err(|e| FsError::Io(format!("unreadable: {e}")))?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let clean = Path::new(file_name)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| FsError::BadInput(format!("bad file name: {file_name}")))?;
        let stored_name = if clauro_fs::is_reserved_file_name(clean) {
            format!("_{clean}")
        } else {
            clean.to_string()
        };
        let scope = self.project_id.as_deref().unwrap_or("unprojected");
        let rel = format!("attachments/{scope}/{stored_name}");
        let existing = self
            .store
            .lock()
            .map_err(|_| FsError::Io("store busy, retry the call".to_string()))?
            .attachment_path_for_hash(self.project_id.as_deref(), &hash);
        if let Some(path) = existing {
            let size = std::fs::metadata(self.session_root.join(&path))
                .map(|m| m.len())
                .unwrap_or(bytes.len() as u64);
            return Ok(AttachmentMeta {
                path,
                size,
                media_type: media_type_for(&stored_name),
                name: stored_name,
            });
        }
        // Containment decided on the CANONICAL path (audit 11): ingest was
        // the only write path that never went through `resolve_session` —
        // `session_root.join(rel)` then `fs::write`, no canonicalisation, no
        // containment, so a junction planted at `attachments/` redirected
        // the copy straight outside the workspace. Same resolve as every
        // other write, then THE write path — staging included (audit 11 NIT:
        // ingest bypassed `stage_write`, contradicting the module header).
        let dest = self.resolve_session(&rel)?;
        self.stage_write(&dest, &bytes)?;
        self.store
            .lock()
            .map_err(|_| FsError::Io("store busy, retry the call".to_string()))?
            .insert_attachment(clauro_store::NewAttachment {
                id: Store::new_id("att"),
                project_id: self.project_id.clone(),
                path: rel.clone(),
                content_hash: hash,
                bytes: bytes.len() as i64,
                media_type: media_type_for(&stored_name),
                name: stored_name.clone(),
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            })
            .map_err(|e| FsError::Io(format!("attachment row failed: {e}")))?;
        Ok(AttachmentMeta {
            path: rel,
            size: bytes.len() as u64,
            media_type: media_type_for(&stored_name),
            name: stored_name,
        })
    }

    fn dispatch(&self, input: &Value, _ctx: &ToolContext) -> ToolOutcome {
        match self.dispatch_cmd(input) {
            Ok(preview) => ToolOutcome::Ok {
                preview,
                preview_path: None,
                full_path: None,
            },
            Err(e) => ToolOutcome::Error {
                message: e.to_string(),
            },
        }
    }
}

/// What the model learns about an upload: path + size + media type. Never
/// the file's bytes inline (D47).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentMeta {
    pub path: String,
    pub size: u64,
    pub media_type: String,
    pub name: String,
}

/// Served-file disposition (D109.2): non-media types download as attachments
/// with sniffing disabled; plain media streams inline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Attachment,
    Inline,
}

/// Response metadata for a served tool-output file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeMeta {
    pub disposition: Disposition,
    pub content_type: String,
    pub nosniff: bool,
}

/// Map a file name to served metadata. SVG and PDF download despite being
/// renderable: SVG carries scripts, and the safe default wins arguments.
#[must_use]
pub fn serve_metadata(file_name: &str) -> ServeMeta {
    let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
    let (content_type, media) = match ext.as_str() {
        "png" => ("image/png", true),
        "jpg" | "jpeg" => ("image/jpeg", true),
        "gif" => ("image/gif", true),
        "webp" => ("image/webp", true),
        "bmp" => ("image/bmp", true),
        "mp3" => ("audio/mpeg", true),
        "wav" => ("audio/wav", true),
        "ogg" => ("audio/ogg", true),
        "mp4" => ("video/mp4", true),
        "webm" => ("video/webm", true),
        "html" | "htm" => ("text/html", false),
        "txt" | "md" => ("text/plain", false),
        "json" => ("application/json", false),
        "pdf" => ("application/pdf", false),
        "svg" => ("image/svg+xml", false),
        _ => ("application/octet-stream", false),
    };
    ServeMeta {
        disposition: if media {
            Disposition::Inline
        } else {
            Disposition::Attachment
        },
        content_type: content_type.to_string(),
        nosniff: !media,
    }
}

fn media_type_for(file_name: &str) -> String {
    serve_metadata(file_name).content_type
}

/// Sanitize a title into a slug: lowercase alphanumerics, dashes, capped at
/// 32 characters. Cosmetic only — opaque IDs stay authoritative (D32).
#[must_use]
pub fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = true;
    for c in title.to_lowercase().chars().take(32) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

/// Session directory: `<id>-<slug>` under the scope parent, fixed at
/// creation. The slug is cosmetic; lookup is by id prefix, so a retitle
/// never orphans files (D32) — nothing ever recomputes this from a live title.
#[must_use]
pub fn session_dir(parent: &Path, id: &str, title: &str) -> PathBuf {
    parent.join(format!("{}-{}", id, slugify(title)))
}

/// Find a session directory by opaque id, ignoring whatever slug it was
/// created with. This — not the title — is how a retitled thread locates its
/// files.
#[must_use]
pub fn find_session_dir(parent: &Path, id: &str) -> Option<PathBuf> {
    let prefix = format!("{id}-");
    std::fs::read_dir(parent)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix))
        })
}

/// Bind the `fs` handler onto a session-scoped host.
pub fn register_fs(reg: &mut Registry, host: Arc<FsHost>) {
    let _ = reg.set_handler("fs", move |input: &Value, ctx: &ToolContext| {
        host.dispatch(input, ctx)
    });
}

impl FsHost {
    /// The session root this host confines children and writes to.
    #[must_use]
    pub fn session_root(&self) -> &Path {
        &self.session_root
    }

    /// The store handle, for handlers that persist rows.
    #[must_use]
    pub fn store_handle(&self) -> &Arc<Mutex<Store>> {
        &self.store
    }
}
