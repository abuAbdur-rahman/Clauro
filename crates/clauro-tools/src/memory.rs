//! The `memory` tool: a topic store, not a summariser (D7).
//!
//! Six commands — view, create, str_replace, insert, delete, rename — over
//! project-scoped rows. The model writes memory itself; there is no
//! background extractor. Return strings are SQLite-native output, not a
//! contract. Three controls never collapsed (D8, D9): account pause, account
//! reset, per-thread off. Secret-shaped writes are refused silently (D43).
//! Memory is retrieved just-in-time by the model, never injected into the
//! frozen system prompt (D11).

use crate::secret::looks_secret;
use clauro_core::{ToolContext, ToolOutcome};
use clauro_fs::check_relative_path;
use clauro_store::{NewMemory, Store};
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard};

/// Refusals that must reveal nothing about the guard share one message.
const REFUSED: &str = "write refused";

/// Paths live under this virtual root. `/memories` itself is the list view;
/// it is never a note, never deletable, never renamable.
const ROOT: &str = "/memories";

fn err(message: impl Into<String>) -> ToolOutcome {
    ToolOutcome::Error {
        message: message.into(),
    }
}

fn ok(preview: impl Into<String>) -> ToolOutcome {
    ToolOutcome::Ok {
        preview: preview.into(),
        preview_path: None,
        full_path: None,
    }
}

fn lock(store: &Arc<Mutex<Store>>) -> Result<MutexGuard<'_, Store>, ToolOutcome> {
    store.lock().map_err(|_| err("store busy, retry the call"))
}

/// Split `/memories/<rest>` into scope-checked components. `None` rest means
/// the root itself.
fn split_path(path: &str) -> Result<Option<String>, ToolOutcome> {
    let rest = path
        .strip_prefix(ROOT)
        .ok_or_else(|| err(format!("path must start with {ROOT}: {path}")))?;
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    if rest.is_empty() {
        return Ok(None);
    }
    // Virtual, not filesystem: the pure check rejects traversal, absolute
    // forms, and reserved names. Symlink escape has no meaning without files;
    // the same validator's IO half covers real symlinks in the fs suite.
    check_relative_path(rest).map_err(|e| err(format!("bad memory path: {e}")))?;
    Ok(Some(rest.replace('\\', "/")))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as i64
}

struct Scope {
    project_id: Option<String>,
    paused: bool,
    include_sensitive: bool,
}

/// Resolve the caller's scope: project from the thread, pause and sensitivity
/// from thread settings falling back to account settings.
fn resolve_scope(store: &Store, thread_id: &str) -> Result<Scope, ToolOutcome> {
    let thread = store
        .get_thread(thread_id)
        .map_err(|e| err(format!("thread unreadable: {e}")))?
        .ok_or_else(|| err(format!("no such thread: {thread_id}")))?;
    let (mut paused, mut include_sensitive) = store.get_account_setting().unwrap_or((false, false));
    if let Some((p, s)) = store.get_memory_setting(thread_id) {
        paused = p;
        include_sensitive = s;
    }
    // Per-thread off stops reads and writes (D9); pause stops use (D8).
    if thread.memory_off {
        return Err(err("memory is off for this thread"));
    }
    Ok(Scope {
        project_id: thread.project_id,
        paused,
        include_sensitive,
    })
}

fn guard_paused(scope: &Scope) -> Result<(), ToolOutcome> {
    if scope.paused {
        return Err(err("memory is paused"));
    }
    Ok(())
}

fn list_visible(store: &Store, scope: &Scope) -> Result<String, ToolOutcome> {
    let rows = store
        .list_memories(scope.project_id.as_deref())
        .map_err(|e| err(format!("list failed: {e}")))?;
    Ok(rows
        .iter()
        .filter(|r| scope.include_sensitive || !r.sensitive)
        .map(|r| r.path.clone())
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Build the handler: `Arc<Mutex<Store>>` captured at bind time is the
/// pattern for stateful handlers — the registry passes input + context only.
pub fn memory_handler(store: Arc<Mutex<Store>>) -> impl Fn(&Value, &ToolContext) -> ToolOutcome {
    move |input: &Value, ctx: &ToolContext| {
        let command = match input.get("command").and_then(|c| c.as_str()) {
            Some(c) => c,
            None => {
                return err("command required: view|create|str_replace|insert|delete|rename|reset");
            }
        };
        handle(&store, ctx, command, input)
    }
}

fn handle(
    store: &Arc<Mutex<Store>>,
    ctx: &ToolContext,
    command: &str,
    input: &Value,
) -> ToolOutcome {
    if command == "reset" {
        return reset(store, input);
    }
    let guard = match lock(store) {
        Ok(g) => g,
        Err(e) => return e,
    };
    let scope = match resolve_scope(&guard, &ctx.thread_id) {
        Ok(s) => s,
        Err(e) => return e,
    };
    if let Err(e) = guard_paused(&scope) {
        return e;
    }
    match command {
        "view" => view(&guard, &scope, input),
        "create" => create(&guard, &scope, input),
        "str_replace" => str_replace(&guard, &scope, input),
        "insert" => insert(&guard, &scope, input),
        "delete" => delete(&guard, &scope, input),
        "rename" => rename(&guard, &scope, input),
        _ => err(format!("unknown memory command: {command}")),
    }
}

fn need<'a>(input: &'a Value, field: &str) -> Result<&'a str, ToolOutcome> {
    input
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| err(format!("{field} required")))
}

fn view(store: &Store, scope: &Scope, input: &Value) -> ToolOutcome {
    let path = match need(input, "path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let rel = match split_path(path) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let Some(rel) = rel else {
        return match list_visible(store, scope) {
            Ok(l) => ok(l),
            Err(e) => e,
        };
    };
    let full = format!("{ROOT}/{rel}");
    match find_row(store, scope, &full) {
        Ok(None) => err(format!("no such topic: {full}")),
        Ok(Some(row)) => {
            if row.sensitive && !scope.include_sensitive {
                return err(format!("no such topic: {full}"));
            }
            ok(format!("{}\n\n{}", full, row.body))
        }
        Err(e) => e,
    }
}

fn create(store: &Store, scope: &Scope, input: &Value) -> ToolOutcome {
    let path = match need(input, "path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let body = match need(input, "body") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let rel = match split_path(path) {
        Ok(Some(r)) => r,
        Ok(None) => return err("create needs a full note path"),
        Err(e) => return e,
    };
    if looks_secret(body) {
        return err(REFUSED);
    }
    let full = format!("{ROOT}/{rel}");
    if find_row(store, scope, &full)
        .map(|r| r.is_some())
        .unwrap_or(false)
    {
        return err(format!("topic exists: {full}"));
    }
    let category = input
        .get("category")
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| rel.split('/').next().unwrap_or("notes").to_string());
    let sensitive = input
        .get("sensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    match store.insert_memory(NewMemory {
        id: Store::new_id("mem"),
        project_id: scope.project_id.clone(),
        topic: category,
        path: full.clone(),
        body: body.to_string(),
        sensitive,
        updated_at: now_ms(),
    }) {
        Ok(()) => {
            if sensitive {
                ok(format!("created {full} [sensitive]"))
            } else {
                ok(format!("created {full}"))
            }
        }
        Err(e) => err(format!("create failed: {e}")),
    }
}

fn str_replace(store: &Store, scope: &Scope, input: &Value) -> ToolOutcome {
    let path = match need(input, "path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let old_str = match need(input, "old_str") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let new_str = match need(input, "new_str") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let rel = match split_path(path) {
        Ok(Some(r)) => r,
        Ok(None) => return err("str_replace needs a note path"),
        Err(e) => return e,
    };
    let full = format!("{ROOT}/{rel}");
    let row = match find_row(store, scope, &full) {
        Ok(Some(r)) => r,
        Ok(None) => return err(format!("no such topic: {full}")),
        Err(e) => return e,
    };
    if !row.body.contains(old_str) {
        return err(format!("old_str not found in {full}"));
    }
    let body = row.body.replacen(old_str, new_str, 1);
    if looks_secret(&body) {
        return err(REFUSED);
    }
    match store.memory_replace_body(&row.id, &body, now_ms()) {
        Ok(_) => ok(format!("replaced in {full}")),
        Err(e) => err(format!("replace failed: {e}")),
    }
}

fn insert(store: &Store, scope: &Scope, input: &Value) -> ToolOutcome {
    let path = match need(input, "path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let text = match need(input, "text") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let rel = match split_path(path) {
        Ok(Some(r)) => r,
        Ok(None) => return err("insert needs a note path"),
        Err(e) => return e,
    };
    let full = format!("{ROOT}/{rel}");
    let row = match find_row(store, scope, &full) {
        Ok(Some(r)) => r,
        Ok(None) => return err(format!("no such topic: {full}")),
        Err(e) => return e,
    };
    let mut lines: Vec<&str> = row.body.lines().collect();
    let at = input
        .get("line")
        .and_then(|v| v.as_u64())
        .map(|n| (n as usize).saturating_sub(1).min(lines.len()))
        .unwrap_or(lines.len());
    let insert_lines: Vec<&str> = text.lines().collect();
    lines.splice(at..at, insert_lines);
    let body = lines.join("\n");
    if looks_secret(&body) {
        return err(REFUSED);
    }
    match store.memory_replace_body(&row.id, &body, now_ms()) {
        Ok(_) => ok(format!("inserted into {full}")),
        Err(e) => err(format!("insert failed: {e}")),
    }
}

fn delete(store: &Store, scope: &Scope, input: &Value) -> ToolOutcome {
    let path = match need(input, "path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let rel = match split_path(path) {
        Ok(Some(r)) => r,
        Ok(None) => return err(format!("cannot delete {ROOT}")),
        Err(e) => return e,
    };
    let full = format!("{ROOT}/{rel}");
    match store.delete_memory_by_path(scope.project_id.as_deref(), &full) {
        Ok(true) => ok(format!("deleted {full}")),
        Ok(false) => err(format!("no such topic: {full}")),
        Err(e) => err(format!("delete failed: {e}")),
    }
}

fn rename(store: &Store, scope: &Scope, input: &Value) -> ToolOutcome {
    let old_path = match need(input, "old_path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let new_path = match need(input, "new_path") {
        Ok(p) => p,
        Err(e) => return e,
    };
    let old_rel = match split_path(old_path) {
        Ok(Some(r)) => r,
        Ok(None) => return err(format!("cannot rename {ROOT}")),
        Err(e) => return e,
    };
    let new_rel = match split_path(new_path) {
        Ok(Some(r)) => r,
        Ok(None) => return err("rename needs a full new path"),
        Err(e) => return e,
    };
    let old_full = format!("{ROOT}/{old_rel}");
    let new_full = format!("{ROOT}/{new_rel}");
    let row = match find_row(store, scope, &old_full) {
        Ok(Some(r)) => r,
        Ok(None) => return err(format!("no such topic: {old_full}")),
        Err(e) => return e,
    };
    if find_row(store, scope, &new_full)
        .map(|r| r.is_some())
        .unwrap_or(false)
    {
        return err(format!("topic exists: {new_full}"));
    }
    match store.rename_memory_path(&row.id, &new_full, now_ms()) {
        Ok(()) => ok(format!("renamed {old_full} to {new_full}")),
        Err(e) => err(format!("rename failed: {e}")),
    }
}

fn reset(store: &Arc<Mutex<Store>>, input: &Value) -> ToolOutcome {
    if input.get("confirm").and_then(|v| v.as_bool()) != Some(true) {
        return err("reset needs confirm:true — it deletes every memory in every project");
    }
    match lock(store) {
        Ok(guard) => match guard.delete_all_memories() {
            Ok(n) => ok(format!("removed {n} memories")),
            Err(e) => err(format!("reset failed: {e}")),
        },
        Err(e) => e,
    }
}

// ── row access (scope-filtered, sensitivity-aware listing) ──

/// Find one row by full path within the caller's scope.
fn find_row(store: &Store, scope: &Scope, full: &str) -> Result<Option<ScopedRow>, ToolOutcome> {
    let rows = store
        .list_memories(scope.project_id.as_deref())
        .map_err(|e| err(format!("list failed: {e}")))?;
    Ok(rows
        .into_iter()
        .find(|r| r.path == full)
        .map(|r| ScopedRow {
            id: r.id,
            body: r.body,
            sensitive: r.sensitive,
        }))
}

struct ScopedRow {
    id: String,
    body: String,
    sensitive: bool,
}
