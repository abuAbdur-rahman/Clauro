//! `clauro-fs`: the workspace tree, path safety, and (later) the runner.
//!
//! Task 004 owns the path-safety half: every model-supplied path resolves
//! inside a Clauro-owned root or fails with a typed error. Order is
//! load-bearing (D34): canonicalise, resolve symlinks and junctions, **then**
//! check traversal — checking first is bypassable.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

pub mod runner;

/// Conservative design target, budgeted from the drive root, not from `~`
/// (D79). `MAX_PATH` is opt-out since Windows 10 1607 and bypassable with the
/// `\\?\` prefix, so this is a floor for surprise, not a filesystem truth.
pub const MAX_PATH_LEN: usize = 260;

/// Why a model-supplied path was refused. Typed, so the loop can return it as
/// a result instead of throwing across the boundary (D55).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathError {
    /// Empty input, or nothing left after `.` / separator stripping.
    Empty,
    /// Absolute paths, drive letters, UNC shares, and the `\\?\` bypass.
    Absolute,
    /// A `..` component survived decoding — the escape attempt itself.
    Traversal,
    /// A Windows reserved device name, case-insensitively, with any extension:
    /// `NUL.txt` is `NUL` (D79).
    ReservedName(String),
    /// The resolved absolute path meets the `MAX_PATH` budget.
    TooLong,
    /// The canonicalised path is not under the canonicalised root. This is the
    /// check that catches a symlink pointing outside the tree (D34).
    OutsideTree,
    /// The filesystem itself refused (missing root, I/O failure).
    Io(String),
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("empty path"),
            Self::Absolute => f.write_str("absolute paths are refused"),
            Self::Traversal => f.write_str("path escapes its directory (..)"),
            Self::ReservedName(n) => write!(f, "reserved device name: {n}"),
            Self::TooLong => write!(f, "path meets the {MAX_PATH_LEN}-char budget"),
            Self::OutsideTree => f.write_str("path resolves outside the workspace"),
            Self::Io(e) => write!(f, "filesystem error: {e}"),
        }
    }
}

impl std::error::Error for PathError {}

/// True iff `name` — one path component — is a Windows reserved device name.
///
/// Compares the stem (up to the first `.`, trailing dots/spaces trimmed)
/// case-insensitively against `CON PRN AUX NUL COM1–COM9 LPT1–LPT9` plus the
/// superscript variants `COM¹²³` / `LPT¹²³` (D79).
#[must_use]
pub fn is_reserved_file_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("");
    let upper = stem.trim_matches([' ', '.']).to_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(rest) = upper.strip_prefix(prefix) {
            if matches!(
                rest,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ) {
                return true;
            }
        }
    }
    false
}

/// True iff the already-canonical `candidate` sits under the
/// already-canonical `root`. Component-wise (`Path::starts_with`), so
/// `/tmp/clauro-root-other` is not inside `/tmp/clauro-root.
///
/// Both inputs must already be canonicalised — this is the check that runs
/// *after* resolution (D34), and lexical paths must never reach it directly.
#[must_use]
pub fn is_within(root_canonical: &Path, candidate_canonical: &Path) -> bool {
    candidate_canonical.starts_with(root_canonical)
}

/// Decode `%HH` triplets. Lone `%` and invalid triplets stay literal.
/// Decoding runs *before* every check, so `%2e%2e%2f` cannot smuggle `../`.
fn percent_decode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }

    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let triplet: Option<u8> = if bytes[i] == b'%' && i + 2 < bytes.len() {
            match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(hi), Some(lo)) => Some(hi << 4 | lo),
                _ => None,
            }
        } else {
            None
        };
        if let Some(decoded) = triplet {
            out.push(decoded);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Check a model-supplied relative path without touching the filesystem:
/// decode → reject absolute → reject `..`, reserved names → joinable tail.
/// Used directly for virtual paths (`/memories/...`); `resolve_in_workspace`
/// adds canonicalisation, symlink resolution, containment, and budget.
pub fn check_relative_path(user: &str) -> Result<PathBuf, PathError> {
    if user.is_empty() {
        return Err(PathError::Empty);
    }
    // Backslashes are separators on the development host (Windows-only, §8a),
    // so normalise before anything else. The containment check at the end of
    // `resolve_in_workspace` is what makes this safe rather than trusting the
    // split.
    let decoded = percent_decode(user).replace('\\', "/");
    if decoded.starts_with('/')
        || decoded.starts_with("//")
        || (decoded.len() >= 2
            && decoded.as_bytes()[1] == b':'
            && decoded.as_bytes()[0].is_ascii_alphabetic())
    {
        return Err(PathError::Absolute);
    }

    let mut rel = PathBuf::new();
    for part in decoded.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(PathError::Traversal);
        }
        if is_reserved_file_name(part) {
            return Err(PathError::ReservedName(part.to_string()));
        }
        rel.push(part);
    }
    if rel.as_os_str().is_empty() {
        return Err(PathError::Empty);
    }
    Ok(rel)
}

/// Resolve a model-supplied `user` path inside `root`.
///
/// Pipeline: `check_relative_path` (pure) → canonicalise the root → resolve
/// symlinks/junctions through the longest existing prefix → containment
/// check → length budget.
///
/// The returned path is absolute and canonical up to its non-existent tail.
pub fn resolve_in_workspace(root: &Path, user: &str) -> Result<PathBuf, PathError> {
    let rel = check_relative_path(user)?;
    let root_canon = root
        .canonicalize()
        .map_err(|e| PathError::Io(e.to_string()))?;
    let abs = root_canon.join(&rel);
    let resolved: PathBuf = match abs.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Dangling tail: resolve the longest existing ancestor (which
            // follows any symlinks *inside* the existing prefix) and re-append
            // the remainder lexically.
            let mut missing: Vec<OsString> = Vec::new();
            let mut ancestor = abs.as_path();
            while !ancestor.exists() {
                match ancestor.file_name() {
                    Some(f) => {
                        missing.push(f.to_os_string());
                        ancestor = ancestor.parent().ok_or(PathError::OutsideTree)?;
                    }
                    None => return Err(PathError::OutsideTree),
                }
            }
            let base = ancestor
                .canonicalize()
                .map_err(|e| PathError::Io(e.to_string()))?;
            let mut rebuilt = base;
            for tail in missing.iter().rev() {
                rebuilt.push(tail);
            }
            rebuilt
        }
    };

    if !is_within(&root_canon, &resolved) {
        return Err(PathError::OutsideTree);
    }
    if resolved.to_string_lossy().chars().count() >= MAX_PATH_LEN {
        return Err(PathError::TooLong);
    }
    Ok(resolved)
}
