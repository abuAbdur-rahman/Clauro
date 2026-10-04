//! Task 004 — the append-only guarantee, enforced mechanically (RED).
//!
//! `message` and `block` are **fully** append-only: not one mutable column
//! (`CONTRACTS.md` §1). The task demands more than "the runtime rejects it":
//! **the write path must be absent.** If this crate ever grows an `UPDATE`
//! statement touching either table, that is the defect, and this test names it.
//!
//! Convention this test enforces on `clauro-store/src/` (one-line SQL, `UPDATE`
//! always uppercase): a line trips iff it contains the `UPDATE` keyword *and*
//! the whole word `message` or `block`. Setter lines name only their own table,
//! and prose in `src/` says "write path", never the keyword — so a trip is a
//! real statement, not a comment.
//!
//! The second test inverts the same scan: every `UPDATE <table>` must target
//! the allowlist, and every column it sets must be on that table's list. A new
//! mutable column without a D-number and a `CONTRACTS.md` §1 row fails here.

use std::collections::{BTreeMap, BTreeSet};

fn src_lines() -> Vec<(String, String)> {
    let dir = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
    let mut out = Vec::new();
    let mut stack = vec![dir];
    while let Some(top) = stack.pop() {
        let entries = std::fs::read_dir(&top).expect("src must be listable");
        for entry in entries {
            let path = entry.expect("dir entry must read").path();
            if path.is_dir() {
                stack.push(path.to_string_lossy().into_owned());
            } else if path.extension().is_some_and(|e| e == "rs") {
                let body = std::fs::read_to_string(&path).expect("src file must read");
                for line in body.lines() {
                    out.push((path.to_string_lossy().into_owned(), line.to_string()));
                }
            }
        }
    }
    out
}

fn is_word(hay: &str, needle: &str) -> bool {
    hay.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|w| w == needle)
}

#[test]
fn no_write_path_on_message_or_block() {
    let mut trips = Vec::new();
    for (file, line) in src_lines() {
        if line.contains("UPDATE") && (is_word(&line, "message") || is_word(&line, "block")) {
            trips.push(format!("{file}: {line}"));
        }
        let lower = line.to_lowercase();
        if (lower.contains("update_message")
            || lower.contains("update_block")
            || lower.contains("delete_message")
            || lower.contains("delete_block"))
            && !line.trim_start().starts_with("//!")
            && !line.trim_start().starts_with("///")
            && !line.trim_start().starts_with("//")
        {
            trips.push(format!("{file}: {line}"));
        }
    }
    assert!(
        trips.is_empty(),
        "append-only violation: message/block must have no write path:\n{}",
        trips.join("\n")
    );
}

#[test]
fn every_update_targets_the_mutable_column_allowlist() {
    // CONTRACTS.md §1 "MUTABLE COLUMNS". account_setting rides with
    // memory_setting: it was split out of it and its two flags need the same
    // single write path to be set at all.
    let allow: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::from([
        (
            "project",
            BTreeSet::from(["name", "instructions", "bash_enabled", "archived_at"]),
        ),
        ("thread", BTreeSet::from(["title"])),
        (
            "memory",
            BTreeSet::from(["body", "revision", "sensitive", "updated_at"]),
        ),
        (
            "memory_setting",
            BTreeSet::from(["paused", "include_sensitive"]),
        ),
        (
            "account_setting",
            BTreeSet::from(["paused", "include_sensitive"]),
        ),
        ("artifact", BTreeSet::from(["compiled_path"])),
    ]);
    let mut violations = Vec::new();
    for (file, line) in src_lines() {
        let Some(at) = line.find("UPDATE ") else {
            continue;
        };
        let rest = &line[at + "UPDATE ".len()..];
        let table: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if table.is_empty() || table == "SET" {
            continue;
        }
        let Some(cols) = allow.get(table.as_str()) else {
            violations.push(format!("{file}: UPDATE on non-mutable table: {line}"));
            continue;
        };
        let Some(set_at) = line.find("SET ") else {
            violations.push(format!("{file}: UPDATE without SET: {line}"));
            continue;
        };
        let clause = line[set_at + "SET ".len()..]
            .split("WHERE")
            .next()
            .unwrap_or("");
        for piece in clause.split(',') {
            let Some((col, _)) = piece.split_once('=') else {
                continue;
            };
            let col = col.trim();
            if col.contains(' ') || col.is_empty() {
                continue; // placeholders (`?1`), not columns
            }
            if !cols.contains(col) {
                violations.push(format!(
                    "{file}: {table}.{col} is not on the mutable list: {line}"
                ));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "mutable-column violations:\n{}",
        violations.join("\n")
    );
}
