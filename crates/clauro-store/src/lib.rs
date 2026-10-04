//! `clauro-store`: SQLite. `CONTRACTS.md` §1 DDL verbatim. `rusqlite` only.
//!
//! Append-only by default (D19). `message` and `block` expose inserts and
//! reads and nothing else — a correction is a new row at a higher `seq`, never
//! a mutation. The mutable columns are exactly the `CONTRACTS.md` §1 list,
//! each with one named setter; `tests/append_only.rs` scans this directory
//! and fails the build on anything else.

use clauro_core::ToolStatus;
use rusqlite::{Connection, OptionalExtension};
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub mod transcript;

/// DDL, verbatim from `CONTRACTS.md` §1 (D19, D63, D57, D7, D8, D35, D47,
/// D52, D84). The two `PRAGMA` lines are *not* here: `journal_mode` and
/// `foreign_keys` are connection state and are set on every `open`, not just
/// at creation time.
const SCHEMA_SQL: &str = r#"
CREATE TABLE project (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  bash_enabled INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE thread (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES project(id),
  title       TEXT,
  incognito   INTEGER NOT NULL DEFAULT 0,
  memory_off  INTEGER NOT NULL DEFAULT 0,

  system_frozen TEXT NOT NULL,
  tools_frozen TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_thread_project ON thread(project_id, created_at DESC);

CREATE TABLE message (
  id        TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id),
  seq       INTEGER NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_message_seq ON message(thread_id, seq);

CREATE TABLE block (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id),
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  boundary   INTEGER,
  is_summary INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  signature  TEXT,
  dropped    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_block_msg ON block(message_id, seq);

CREATE TABLE usage (
  id               TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES thread(id),
  message_id       TEXT REFERENCES message(id),
  run_id           TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  summary_tokens   INTEGER NOT NULL DEFAULT 0,
  summary_used_tokens INTEGER,
  iterations       TEXT,
  context_budget   INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_usage_thread ON usage(thread_id, created_at);

CREATE TABLE tool_result (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES thread(id),
  tool_call_id   TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok','error','aborted','rejected')),
  preview        TEXT NOT NULL,
  preview_path   TEXT,
  full_path      TEXT,
  output_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE (thread_id, tool_call_id)
);
CREATE INDEX idx_tool_result_call ON tool_result(tool_call_id);

CREATE TABLE memory (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id),
  topic      TEXT NOT NULL,
  path       TEXT NOT NULL,
  body       TEXT NOT NULL,
  sensitive  INTEGER NOT NULL DEFAULT 0,
  revision   INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_global_path ON memory(path) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_memory_project_path ON memory(project_id, path) WHERE project_id IS NOT NULL;

CREATE TABLE memory_setting (
  thread_id  TEXT PRIMARY KEY REFERENCES thread(id),
  paused     INTEGER NOT NULL DEFAULT 0,
  include_sensitive INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE account_setting (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  paused          INTEGER NOT NULL DEFAULT 0,
  include_sensitive INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE attachment (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id),
  path       TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, content_hash)
);
CREATE UNIQUE INDEX idx_attachment_global_hash ON attachment(content_hash) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_attachment_project_hash ON attachment(project_id, content_hash) WHERE project_id IS NOT NULL;

CREATE TABLE artifact (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES thread(id),
  version       INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL,
  media_type    TEXT NOT NULL,
  source_path   TEXT NOT NULL,
  compiled_path TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (thread_id, id, version)
);

CREATE TABLE compaction_event (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES thread(id),
  generation  INTEGER NOT NULL,
  summary_block TEXT NOT NULL,
  covers_from INTEGER NOT NULL,
  covers_to   INTEGER NOT NULL,
  summary_tokens     INTEGER NOT NULL DEFAULT 0,
  summary_used_tokens INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (thread_id, generation)
);
CREATE INDEX idx_compaction_thread ON compaction_event(thread_id, generation DESC);
"#;

// ── errors ───────────────────────────────────────────────────────────────────

/// Every failure this crate can produce. Nothing crosses to callers untyped.
#[derive(Debug)]
pub enum StoreError {
    /// The engine refused (constraint, FK, I/O).
    Sqlite(rusqlite::Error),
    /// A row the caller expected is not there.
    NotFound(String),
    /// A `block` would move its thread's generation backwards (I3, D63).
    GenerationRegression { thread: String, got: i64, max: i64 },
    /// A compaction must advance its thread's generation strictly by one (D63,
    /// D84: `UNIQUE (thread_id, generation)` is the second guard).
    BadCompactionGeneration { thread: String, got: i64, want: i64 },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "sqlite: {e}"),
            Self::NotFound(id) => write!(f, "row not found: {id}"),
            Self::GenerationRegression { thread, got, max } => write!(
                f,
                "generation regression on thread {thread}: got {got}, max is {max}"
            ),
            Self::BadCompactionGeneration { thread, got, want } => write!(
                f,
                "compaction on thread {thread} must be generation {want}, got {got}"
            ),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

// ── row shapes ───────────────────────────────────────────────────────────────

/// `message.role`. The `CHECK` in DDL agrees; the enum makes Rust callers
/// agree too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

impl MessageRole {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProject {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub bash_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewThread {
    pub id: String,
    pub project_id: Option<String>,
    pub title: Option<String>,
    pub incognito: bool,
    pub memory_off: bool,
    pub system_frozen: String,
    pub tools_frozen: String,
}

/// One thread row, for the loop's frozen-prefix check (D19).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadRow {
    pub id: String,
    pub project_id: Option<String>,
    pub title: Option<String>,
    pub system_frozen: String,
    pub tools_frozen: String,
}

/// Append-only: insert + read. `seq` gaps are legal; a compaction removes a
/// run, it never renumbers (D63).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMessage {
    pub id: String,
    pub thread_id: String,
    pub seq: i64,
    pub role: MessageRole,
    pub created_at: i64,
}

/// Append-only: insert + read. Not one column on this table is mutable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewBlock {
    pub id: String,
    pub message_id: String,
    pub seq: i64,
    pub kind: String,
    pub payload: String,
    pub boundary: Option<i64>,
    pub is_summary: bool,
    pub generation: i64,
    pub signature: Option<String>,
    pub dropped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewUsage {
    pub id: String,
    pub thread_id: String,
    pub message_id: Option<String>,
    pub run_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// Separate channel (D57). Never folded into the ordinary totals.
    pub summary_tokens: i64,
    /// Pre-invoke compacted size. `None` when this turn did not summarize.
    pub summary_used_tokens: Option<i64>,
    /// `usage.iterations`: the only source after a compaction (D70).
    pub iterations: Option<String>,
    pub context_budget: Option<i64>,
    pub created_at: i64,
}

/// Ordinary-channel sums only. `summary_*` is kept out by construction: the
/// query below names the four ordinary columns, so a future reader cannot
/// re-fold the compaction channel by accident (D57).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UsageTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewToolResult {
    pub id: String,
    pub thread_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub status: ToolStatus,
    pub preview: String,
    pub preview_path: Option<String>,
    pub full_path: Option<String>,
    pub output_bytes: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMemory {
    pub id: String,
    pub project_id: Option<String>,
    pub topic: String,
    pub path: String,
    pub body: String,
    pub sensitive: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRow {
    pub id: String,
    pub body: String,
    pub revision: i64,
    pub sensitive: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAttachment {
    pub id: String,
    pub project_id: Option<String>,
    pub path: String,
    /// Dedupe scope is the project, never global (D52).
    pub content_hash: String,
    pub bytes: i64,
    pub media_type: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewArtifact {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub media_type: String,
    pub source_path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockRow {
    pub id: String,
    pub seq: i64,
    pub generation: i64,
}

/// A compaction writes one ledger row and nothing else; covered rows stay on
/// disk as superseded (D84). The surface is a query over this table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCompactionEvent {
    pub id: String,
    pub thread_id: String,
    pub generation: i64,
    pub summary_block: String,
    pub covers_from: i64,
    pub covers_to: i64,
    pub summary_tokens: i64,
    pub summary_used_tokens: Option<i64>,
    pub created_at: i64,
}

// ── the store ────────────────────────────────────────────────────────────────

/// The SQLite file. One method per write path in `CONTRACTS.md` §1; anything
/// else is a bug, and `tests/append_only.rs` says so mechanically.
pub struct Store {
    conn: Connection,
}

static ID_SEQ: AtomicU64 = AtomicU64::new(0);

impl Store {
    /// Opaque, stable IDs (D32). Timestamp + process + counter: unique without
    /// a dependency, meaningless without the row.
    #[must_use]
    pub fn new_id(prefix: &str) -> String {
        let n = ID_SEQ.fetch_add(1, Ordering::SeqCst);
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{prefix}_{ms}_{}_{n}", std::process::id())
    }

    fn init(conn: Connection) -> Result<Self, StoreError> {
        // A reader never blocks the writer; a dangling row is a bug, not a
        // warning. Set on every open: these are connection state, and the file
        // outlives any one handle.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // The file outlives any one handle, so reopening must not replay the
        // DDL. `user_version` gates creation (and later migrations); the DDL
        // above stays verbatim rather than gaining IF NOT EXISTS on every line.
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            conn.execute_batch(SCHEMA_SQL)?;
            conn.pragma_update(None, "user_version", 1)?;
        }
        Ok(Self { conn })
    }

    /// Open (creating) the file-backed database.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::init(Connection::open(path)?)
    }

    /// Headless tests. Same DDL; `journal_mode` on `:memory:` stays `memory`
    /// (SQLite decides), so the WAL assertion in `tests/schema.rs` opens a
    /// file instead.
    pub fn open_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    /// What `PRAGMA journal_mode` reports for this handle.
    pub fn journal_mode(&self) -> String {
        self.conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap_or_else(|_| "unknown".to_string())
    }

    /// What `PRAGMA foreign_keys` reports for this handle.
    pub fn foreign_keys_on(&self) -> bool {
        self.conn
            .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
            .map(|v| v == 1)
            .unwrap_or(false)
    }

    /// User tables (no `sqlite_%` internals), for the twelve-table assertion.
    pub fn table_names(&self) -> Vec<String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .expect("sqlite_master must be readable");
        stmt.query_map([], |row| row.get(0))
            .expect("table list must read")
            .filter_map(Result::ok)
            .collect()
    }

    /// Raw DDL for one table, for the column/constraint assertions.
    pub fn table_sql(&self, table: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .optional()
            .expect("sqlite_master must be readable")
    }

    // ── inserts: the only write path for append-only tables ──

    pub fn insert_project(&self, p: NewProject) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO project (id, name, instructions, bash_enabled, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                p.id,
                p.name,
                p.instructions,
                i64::from(p.bash_enabled),
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn insert_thread(&self, t: NewThread) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO thread (id, project_id, title, incognito, memory_off, system_frozen, tools_frozen, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                t.id,
                t.project_id,
                t.title,
                i64::from(t.incognito),
                i64::from(t.memory_off),
                t.system_frozen,
                t.tools_frozen,
                now_ms()
            ],
        )?;
        Ok(())
    }

    /// One thread row. The loop reads `system_frozen` to prove the prefix it
    /// is about to extend is the one the thread started with (D19).
    pub fn get_thread(&self, id: &str) -> Result<Option<ThreadRow>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, project_id, title, system_frozen, tools_frozen FROM thread WHERE id = ?1",
                [id],
                |row| {
                    Ok(ThreadRow {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        title: row.get(2)?,
                        system_frozen: row.get(3)?,
                        tools_frozen: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn insert_message(&self, m: NewMessage) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO message (id, thread_id, seq, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![m.id, m.thread_id, m.seq, m.role.as_str(), m.created_at],
        )?;
        Ok(())
    }

    /// Refuses a generation regression with a typed error, so I3
    /// (non-decreasing along `(thread, seq)`) holds by construction (D63).
    pub fn insert_block(&self, b: NewBlock) -> Result<(), StoreError> {
        let thread: String = self.conn.query_row(
            "SELECT thread_id FROM message WHERE id = ?1",
            [&b.message_id],
            |row| row.get(0),
        )?;
        let max: Option<i64> = self
            .conn
            .query_row(
                "SELECT MAX(b.generation) FROM block b JOIN message m ON b.message_id = m.id WHERE m.thread_id = ?1",
                [&thread],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if let Some(max) = max {
            if b.generation < max {
                return Err(StoreError::GenerationRegression {
                    thread,
                    got: b.generation,
                    max,
                });
            }
        }
        self.conn.execute(
            "INSERT INTO block (id, message_id, seq, kind, payload, boundary, is_summary, generation, signature, dropped) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                b.id,
                b.message_id,
                b.seq,
                b.kind,
                b.payload,
                b.boundary,
                i64::from(b.is_summary),
                b.generation,
                b.signature,
                i64::from(b.dropped)
            ],
        )?;
        Ok(())
    }

    pub fn insert_usage(&self, u: NewUsage) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO usage (id, thread_id, message_id, run_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, summary_tokens, summary_used_tokens, iterations, context_budget, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                u.id,
                u.thread_id,
                u.message_id,
                u.run_id,
                u.input_tokens,
                u.output_tokens,
                u.cache_read_tokens,
                u.cache_write_tokens,
                u.summary_tokens,
                u.summary_used_tokens,
                u.iterations,
                u.context_budget,
                u.created_at
            ],
        )?;
        Ok(())
    }

    /// Ordinary-channel sums. The column list is the D57 proof: `summary_*`
    /// is selected nowhere here.
    pub fn usage_totals(&self, thread_id: &str) -> UsageTotals {
        self.conn
            .query_row(
                "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0) FROM usage WHERE thread_id = ?1",
                [thread_id],
                |row| {
                    Ok(UsageTotals {
                        input_tokens: row.get(0)?,
                        output_tokens: row.get(1)?,
                        cache_read_tokens: row.get(2)?,
                        cache_write_tokens: row.get(3)?,
                    })
                },
            )
            .expect("usage sums must read")
    }

    pub fn insert_tool_result(&self, r: NewToolResult) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO tool_result (id, thread_id, tool_call_id, tool_name, status, preview, preview_path, full_path, output_bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                r.id,
                r.thread_id,
                r.tool_call_id,
                r.tool_name,
                r.status.as_str(),
                r.preview,
                r.preview_path,
                r.full_path,
                r.output_bytes,
                r.created_at
            ],
        )?;
        Ok(())
    }

    pub fn insert_memory(&self, m: NewMemory) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO memory (id, project_id, topic, path, body, sensitive, revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
            rusqlite::params![
                m.id,
                m.project_id,
                m.topic,
                m.path,
                m.body,
                i64::from(m.sensitive),
                m.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_memory(&self, id: &str) -> Option<MemoryRow> {
        self.conn
            .query_row(
                "SELECT id, body, revision, sensitive, updated_at FROM memory WHERE id = ?1",
                [id],
                |row| {
                    Ok(MemoryRow {
                        id: row.get(0)?,
                        body: row.get(1)?,
                        revision: row.get(2)?,
                        sensitive: row.get::<_, i64>(3)? == 1,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .expect("memory read must not fail")
    }

    pub fn insert_attachment(&self, a: NewAttachment) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO attachment (id, project_id, path, content_hash, bytes, media_type, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                a.id,
                a.project_id,
                a.path,
                a.content_hash,
                a.bytes,
                a.media_type,
                a.name,
                a.created_at
            ],
        )?;
        Ok(())
    }

    pub fn insert_artifact(&self, a: NewArtifact) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO artifact (id, thread_id, title, media_type, source_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![a.id, a.thread_id, a.title, a.media_type, a.source_path, a.created_at],
        )?;
        Ok(())
    }

    /// The ledger write. Generation must be exactly previous + 1 (1 when the
    /// thread has never compacted); the `UNIQUE (thread_id, generation)` in
    /// DDL is the second guard (D63, D84).
    pub fn insert_compaction_event(&self, c: NewCompactionEvent) -> Result<(), StoreError> {
        let max: Option<i64> = self
            .conn
            .query_row(
                "SELECT MAX(generation) FROM compaction_event WHERE thread_id = ?1",
                [&c.thread_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let want = max.map_or(1, |m| m + 1);
        if c.generation != want {
            return Err(StoreError::BadCompactionGeneration {
                thread: c.thread_id.clone(),
                got: c.generation,
                want,
            });
        }
        self.conn.execute(
            "INSERT INTO compaction_event (id, thread_id, generation, summary_block, covers_from, covers_to, summary_tokens, summary_used_tokens, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                c.id,
                c.thread_id,
                c.generation,
                c.summary_block,
                c.covers_from,
                c.covers_to,
                c.summary_tokens,
                c.summary_used_tokens,
                c.created_at
            ],
        )?;
        Ok(())
    }

    pub fn compaction_generations(&self, thread_id: &str) -> Vec<i64> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT generation FROM compaction_event WHERE thread_id = ?1 ORDER BY generation",
            )
            .expect("compaction read must prepare");
        stmt.query_map([thread_id], |row| row.get(0))
            .expect("compaction read must run")
            .filter_map(Result::ok)
            .collect()
    }

    pub fn blocks_for_message(&self, message_id: &str) -> Vec<BlockRow> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, seq, generation FROM block WHERE message_id = ?1 ORDER BY seq")
            .expect("block read must prepare");
        stmt.query_map([message_id], |row| {
            Ok(BlockRow {
                id: row.get(0)?,
                seq: row.get(1)?,
                generation: row.get(2)?,
            })
        })
        .expect("block read must run")
        .filter_map(Result::ok)
        .collect()
    }

    // ── the single write path per mutable column (CONTRACTS.md §1) ──

    fn must_touch(&self, rows: usize, what: &str) -> Result<(), StoreError> {
        if rows == 0 {
            return Err(StoreError::NotFound(what.to_string()));
        }
        Ok(())
    }

    /// `project.name` — the user renames a project.
    pub fn rename_project(&self, id: &str, name: &str) -> Result<(), StoreError> {
        let rows = self.conn.execute(
            "UPDATE project SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )?;
        self.must_touch(rows, id)
    }

    /// `project.instructions` — Gems folded into Projects (D35).
    pub fn set_project_instructions(&self, id: &str, text: &str) -> Result<(), StoreError> {
        let rows = self.conn.execute(
            "UPDATE project SET instructions = ?1 WHERE id = ?2",
            rusqlite::params![text, id],
        )?;
        self.must_touch(rows, id)
    }

    /// `project.bash_enabled` — the opt-in is per project (D67).
    pub fn set_project_bash_enabled(&self, id: &str, on: bool) -> Result<(), StoreError> {
        let rows = self.conn.execute(
            "UPDATE project SET bash_enabled = ?1 WHERE id = ?2",
            rusqlite::params![i64::from(on), id],
        )?;
        self.must_touch(rows, id)
    }

    /// `project.archived_at` — soft delete. `None` un-archives.
    pub fn archive_project(&self, id: &str, at: Option<i64>) -> Result<(), StoreError> {
        let rows = self.conn.execute(
            "UPDATE project SET archived_at = ?1 WHERE id = ?2",
            rusqlite::params![at, id],
        )?;
        self.must_touch(rows, id)
    }

    /// `thread.title` — a title is never a path (D32).
    pub fn retitle_thread(&self, id: &str, title: Option<String>) -> Result<(), StoreError> {
        let rows = self.conn.execute(
            "UPDATE thread SET title = ?1 WHERE id = ?2",
            rusqlite::params![title, id],
        )?;
        self.must_touch(rows, id)
    }

    /// `memory.body` + `memory.revision` — `str_replace` bumps, never rewrites
    /// blind (D7). Returns the new revision.
    pub fn memory_replace_body(
        &self,
        id: &str,
        body: &str,
        updated_at: i64,
    ) -> Result<i64, StoreError> {
        let rows = self.conn.execute(
            "UPDATE memory SET body = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![body, updated_at, id],
        )?;
        self.must_touch(rows, id)?;
        Ok(self
            .get_memory(id)
            .expect("just-written memory must read")
            .revision)
    }

    /// `memory.sensitive` — the sensitive-topics opt-in (D8).
    pub fn set_memory_sensitive(
        &self,
        id: &str,
        sensitive: bool,
        updated_at: i64,
    ) -> Result<(), StoreError> {
        let rows = self.conn.execute(
            "UPDATE memory SET sensitive = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![i64::from(sensitive), updated_at, id],
        )?;
        self.must_touch(rows, id)
    }

    /// `memory_setting.*` — pause / include_sensitive (D8). Replace, not a
    /// partial write: the row is the whole setting.
    pub fn upsert_memory_setting(
        &self,
        thread_id: &str,
        paused: bool,
        include_sensitive: bool,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO memory_setting (thread_id, paused, include_sensitive) VALUES (?1, ?2, ?3)",
            rusqlite::params![thread_id, i64::from(paused), i64::from(include_sensitive)],
        )?;
        Ok(())
    }

    /// `account_setting.*` — the singleton split out of `memory_setting`.
    /// Same replace shape; one row, `id = 1`, by DDL construction.
    pub fn upsert_account_setting(
        &self,
        paused: bool,
        include_sensitive: bool,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO account_setting (id, paused, include_sensitive) VALUES (1, ?1, ?2)",
            rusqlite::params![i64::from(paused), i64::from(include_sensitive)],
        )?;
        Ok(())
    }

    /// `artifact.compiled_path` — set once after the Worker transform.
    pub fn set_artifact_compiled_path(&self, id: &str, path: &str) -> Result<(), StoreError> {
        let rows = self.conn.execute(
            "UPDATE artifact SET compiled_path = ?1 WHERE id = ?2",
            rusqlite::params![path, id],
        )?;
        self.must_touch(rows, id)
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as i64
}
