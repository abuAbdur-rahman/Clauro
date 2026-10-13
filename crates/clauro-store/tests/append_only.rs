//! Task 004 — the append-only guarantee, enforced mechanically (RED).
//!
//! `message` and `block` are **fully** append-only: not one mutable column
//! (`CONTRACTS.md` §1). The task demands more than "the runtime rejects it":
//! **the write path must be absent.** If this crate ever grows an `UPDATE`
//! statement touching either table, that is the defect, and this test names it.
//!
//! Three layers, after the V6 audit (`40` CRITICAL, `01` item 24) showed the
//! original one-line uppercase grep was evadable:
//!
//! 1. **The engine.** `trg_message_append_only` / `trg_block_append_only`
//!    (`BEFORE UPDATE … RAISE(ABORT)`, applied on every open) refuse a live
//!    rewrite of either table — asserted behaviourally in `tests/schema.rs`,
//!    whatever SQL a caller spells and whatever case it uses. DELETE is
//!    deliberately **not** trigger-banned: `delete_thread` / `delete_project`
//!    must still remove these rows (D10), so that path is covered by the
//!    behavioural tests in `tests/retention.rs` instead. One honest residual:
//!    `INSERT OR REPLACE` resolves conflicts through that same delete path,
//!    so the schema cannot see it — layer 3 covers the source, and nothing in
//!    production spells it.
//! 2. **A line trip** (case-insensitive): any source line pairing the `update`
//!    keyword with the whole word `message` or `block`. Conservative on
//!    purpose — a subquery read trips it too; false alarms are visible,
//!    false negatives are not. Prose in `src/` says "write path" or
//!    "rewrite", never both keywords on one line, so a trip is a statement.
//! 3. **A statement trip** (`violations_in`): source text split on `;` and
//!    scanned case-insensitively for `UPDATE [OR …] <message|block>` — with
//!    only whitespace between the keyword and the target, so multi-line SQL
//!    cannot hide its target — and for `INSERT OR REPLACE|IGNORE INTO
//!    message|block`. The `RAISE(ABORT)` triggers do not trip this: trigger
//!    syntax puts `ON` between the keyword and the table, so the token after
//!    `UPDATE` is `on`, never the table.
//!
//! The second test inverts the same scan: every `UPDATE <table>` must target
//! the allowlist, and every column it sets must be on that table's list. A new
//! mutable column without a D-number and a `CONTRACTS.md` §1 row fails here.

use std::collections::{BTreeMap, BTreeSet};

fn src_files() -> Vec<(String, String)> {
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
                out.push((path.to_string_lossy().into_owned(), body));
            }
        }
    }
    out
}

fn is_word(hay: &str, needle: &str) -> bool {
    hay.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|w| w == needle)
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Every position where `word` occurs as a whole word in an ASCII-lowercased
/// haystack. Only ASCII case is folded, so byte offsets stay valid.
fn find_word(lower: &str, word: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = lower[from..].find(word) {
        let pos = from + rel;
        let end = pos + word.len();
        let before_ok = pos == 0 || !is_word_byte(lower.as_bytes()[pos - 1]);
        let after_ok = end >= lower.len() || !is_word_byte(lower.as_bytes()[end]);
        if before_ok && after_ok {
            out.push(pos);
        }
        from = end;
    }
    out
}

fn skip_ws(lower: &str, mut pos: usize) -> usize {
    while pos < lower.len() && lower.as_bytes()[pos].is_ascii_whitespace() {
        pos += 1;
    }
    pos
}

/// One SQL identifier from `pos`, skipping quoting; returns it and the
/// position after it. Byte-sliced only across ASCII, so boundaries are safe.
fn read_ident(lower: &str, pos: usize) -> (String, usize) {
    let bytes = lower.as_bytes();
    let mut p = pos;
    while p < bytes.len() && (bytes[p] == b'"' || bytes[p] == b'`' || bytes[p] == b'[') {
        p += 1;
    }
    let start = p;
    while p < bytes.len() && is_word_byte(bytes[p]) {
        p += 1;
    }
    (lower[start..p].to_string(), p)
}

/// Violations in one source file, statement-level and case-insensitive.
///
/// The text is split on `;`, so an `UPDATE` spread over lines cannot hide its
/// target table between two of them (the evasion the V6 audit found). Every
/// `;` inside a string would split a statement in half — that only ever
/// *loses* a detection opportunity for statements that contain no `update` /
/// `insert` word, never merges two statements into a false trip.
fn violations_in(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = text.to_ascii_lowercase();

    // Layer 2: the conservative line trip. Comments included on purpose (the
    // convention is that prose avoids the keyword pair, so a trip is real).
    for line in text.lines() {
        let l = line.to_ascii_lowercase();
        if is_word(&l, "update") && (is_word(&l, "message") || is_word(&l, "block")) {
            out.push(format!(
                "update keyword beside message/block on one line: {line}"
            ));
        }
    }

    for stmt in lower.split(';') {
        // Layer 3a: UPDATE whose target table is message or block.
        for pos in find_word(stmt, "update") {
            let start = skip_ws(stmt, pos + 6);
            let (first, after_first) = read_ident(stmt, start);
            let target_pos = if first == "or" {
                // `UPDATE OR <anything> <table>` — the conflict clause
                // overrides any ON CONFLICT; the target follows it.
                skip_ws(stmt, after_first)
            } else {
                start
            };
            let (target, after_target) = read_ident(stmt, target_pos);
            // A schema-qualified target (`main.message`) is still a target.
            let target = if stmt.as_bytes().get(after_target) == Some(&b'.') {
                read_ident(stmt, after_target + 1).0
            } else {
                target
            };
            if target == "message" || target == "block" {
                out.push(format!(
                    "update targets {target}: {}",
                    stmt.chars().take(120).collect::<String>()
                ));
            }
        }
        // Layer 3b: INSERT OR REPLACE / INSERT OR IGNORE into message or
        // block. Plain INSERT is the append path itself and is fine.
        for pos in find_word(stmt, "insert") {
            let start = skip_ws(stmt, pos + 6);
            let (kw, after_kw) = read_ident(stmt, start);
            if kw != "or" {
                continue;
            }
            let (conflict, after_conflict) = read_ident(stmt, skip_ws(stmt, after_kw));
            if conflict != "replace" && conflict != "ignore" {
                continue;
            }
            let (into, after_into) = read_ident(stmt, skip_ws(stmt, after_conflict));
            let table_pos = if into == "into" {
                skip_ws(stmt, after_into)
            } else {
                skip_ws(stmt, after_conflict)
            };
            let (table, _) = read_ident(stmt, table_pos);
            if table == "message" || table == "block" {
                out.push(format!("insert or {conflict} into {table}"));
            }
        }
    }
    out
}

#[test]
fn the_scan_detects_the_known_evaders_and_ignores_the_legitimate_sql() {
    // The V6 audit's evasions, as scanner fixtures: each MUST be flagged.
    // This test proves the detector detects — without it, a scanner that
    // matches nothing would still be green over a clean tree.
    let evaders = [
        // classic uppercase, same line
        r#"conn.execute("UPDATE message SET role = 'user' WHERE id = 'm'")"#,
        // lowercase
        r#"conn.execute("update message set role = 'user' WHERE id = 'm'")"#,
        // multi-line: target hidden on the next line
        "conn.execute(\"UPDATE\n  message SET role = 'user'\")",
        // conflict-clause disguise
        "conn.execute(\"UPDATE OR REPLACE message SET seq = 2\")",
        // the audit's other named vector
        r#"conn.execute("INSERT OR REPLACE INTO message (id) VALUES ('m')")"#,
        r#"conn.execute("insert or ignore into block (id) VALUES ('b')")"#,
        "conn.execute(\"INSERT\nOR REPLACE\nINTO block (id) VALUES ('b')\")",
        // schema-qualified target
        r#"conn.execute("UPDATE main.block SET payload = '{}'" )"#,
    ];
    for evader in evaders {
        assert!(
            !violations_in(evader).is_empty(),
            "the scanner must flag this evader: {evader}"
        );
    }
    let legitimate = [
        // the triggers themselves: `ON` sits between keyword and table, and
        // the RAISE(ABORT) body never names the keyword
        "CREATE TRIGGER IF NOT EXISTS trg_message_append_only\n  BEFORE UPDATE\n  ON message\n  BEGIN\n    SELECT RAISE(ABORT, 'append-only: message rows are never rewritten');\n  END;",
        // the append path
        r#"conn.execute("INSERT INTO message (id, thread_id, seq, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")"#,
        // the documented mutable columns
        r#"conn.execute("UPDATE thread SET title = ?1 WHERE id = ?2")"#,
        r#"conn.execute("UPDATE provider SET models_fetched_at = ?1 WHERE id = ?2")"#,
        r#"conn.execute("INSERT OR REPLACE INTO memory_setting (thread_id) VALUES (?1)")"#,
        // a subquery READ of message from another table's update — layer 2
        // trips that on one line, but as a statement trip it is not a write
        "conn.execute(\"UPDATE usage SET iterations = ?1 WHERE message_id IN (SELECT id\\nFROM message)\")",
    ];
    for stmt in legitimate {
        let violations: Vec<String> = violations_in(stmt)
            .into_iter()
            .filter(|v| !v.starts_with("update keyword beside"))
            .collect();
        assert!(
            violations.is_empty(),
            "the scanner must not flag legitimate SQL: {violations:?}"
        );
    }
}

#[test]
fn no_write_path_on_message_or_block() {
    let mut trips = Vec::new();
    for (file, body) in src_files() {
        for v in violations_in(&body) {
            trips.push(format!("{file}: {v}"));
        }
        for line in body.lines() {
            let lower = line.to_ascii_lowercase();
            if (lower.contains("update_message")
                || lower.contains("update_block")
                || lower.contains("delete_message")
                || lower.contains("delete_block"))
                && !line.trim_start().starts_with("//")
            {
                trips.push(format!("{file}: suspicious identifier name: {line}"));
            }
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
        ("thread", BTreeSet::from(["title", "memory_off"])),
        (
            "memory",
            BTreeSet::from(["body", "revision", "sensitive", "updated_at", "path"]),
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
        // Providers are configuration, not transcript: the freshness stamp is
        // the documented write path for model-list refresh (003/providers).
        ("provider", BTreeSet::from(["models_fetched_at"])),
    ]);
    let mut violations = Vec::new();
    for (file, body) in src_files() {
        for line in body.lines() {
            // Prose is not a statement; statements are never comments.
            if line.trim_start().starts_with("//") {
                continue;
            }
            let lower = line.to_ascii_lowercase();
            let Some(at) = lower.find("update ") else {
                continue;
            };
            let rest = &lower[at + "update ".len()..];
            let table: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if table.is_empty() || table == "set" {
                continue;
            }
            let Some(cols) = allow.get(table.as_str()) else {
                violations.push(format!("{file}: update on non-mutable table: {line}"));
                continue;
            };
            let Some(set_at) = lower.find("set ") else {
                violations.push(format!("{file}: update without SET: {line}"));
                continue;
            };
            let clause = lower[set_at + "set ".len()..]
                .split("where")
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
    }
    assert!(
        violations.is_empty(),
        "mutable-column violations:\n{}",
        violations.join("\n")
    );
}
