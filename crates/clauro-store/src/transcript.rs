//! Transcript reads and cancel semantics (`CONTRACTS.md` §2, task 006).
//!
//! Three invariants a test asserts without any provider in the loop:
//! - **I1** every `tool_use` has a `tool_result` with the same id, same thread.
//! - **I2** a summary's boundary covers paired calls (checked at compaction,
//!   016 — the reader needed lives here).
//! - **I3** `block.generation` non-decreasing along `(thread, seq)`.
//!
//! Cancel (D65, D68): every *dispatched* call gets a result, including
//! cancelled ones, and completed work is retained — never rolled back.

use crate::{Store, StoreError};
use clauro_core::ToolStatus;
use rusqlite::OptionalExtension;

/// One full block row with its message position, for invariant checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullBlock {
    pub id: String,
    pub message_seq: i64,
    pub role: String,
    pub seq: i64,
    pub kind: String,
    pub payload: String,
    pub generation: i64,
    pub signature: Option<String>,
}

/// One tool result, paired by call id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResultRef {
    pub tool_call_id: String,
    pub status: ToolStatus,
}

/// The I1 verdict: unpaired ids plus blocks too malformed to judge.
// Malformed payloads are reported, not paired: guessing an id for a corrupt
// row would manufacture the pairing the check is supposed to verify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingReport {
    pub unpaired: Vec<String>,
    pub malformed: Vec<String>,
}

/// I1 over already-read rows. Pure: feeds on fixtures as well as live reads.
#[must_use]
pub fn find_unpaired_tool_uses(blocks: &[FullBlock], results: &[ToolResultRef]) -> PairingReport {
    let mut unpaired = Vec::new();
    let mut malformed = Vec::new();
    for block in blocks.iter().filter(|b| b.kind == "tool_use") {
        match serde_json::from_str::<serde_json::Value>(&block.payload)
            .ok()
            .and_then(|v| v.get("id").and_then(|id| id.as_str()).map(str::to_string))
        {
            Some(id) => {
                if !results.iter().any(|r| r.tool_call_id == id) {
                    unpaired.push(id);
                }
            }
            None => malformed.push(block.id.clone()),
        }
    }
    PairingReport {
        unpaired,
        malformed,
    }
}

/// I3 over already-read rows, in surface order. Returns the position of the
/// first regression, if any.
#[must_use]
pub fn check_generation_monotonic(blocks: &[FullBlock]) -> Option<usize> {
    let mut max = i64::MIN;
    for (i, block) in blocks.iter().enumerate() {
        if block.generation < max {
            return Some(i);
        }
        max = max.max(block.generation);
    }
    None
}

/// A dispatched-but-unresolved model call handed to cancellation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCall {
    pub id: String,
    pub name: String,
}

/// What a cancellation closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CancelReport {
    /// Calls closed as `aborted` by this invocation.
    pub aborted: usize,
    /// Calls that already carried a result and were left untouched.
    pub already_resolved: usize,
}

impl Store {
    /// Every block of a thread in surface order, for I1–I3 checks.
    pub fn blocks_for_thread(&self, thread_id: &str) -> Vec<FullBlock> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT b.id, m.seq, m.role, b.seq, b.kind, b.payload, b.generation, b.signature \
                 FROM block b JOIN message m ON b.message_id = m.id \
                 WHERE m.thread_id = ?1 ORDER BY m.seq, b.seq",
            )
            .expect("transcript read must prepare");
        stmt.query_map([thread_id], |row| {
            Ok(FullBlock {
                id: row.get(0)?,
                message_seq: row.get(1)?,
                role: row.get(2)?,
                seq: row.get(3)?,
                kind: row.get(4)?,
                payload: row.get(5)?,
                generation: row.get(6)?,
                signature: row.get(7)?,
            })
        })
        .expect("transcript read must run")
        .filter_map(Result::ok)
        .collect()
    }

    /// Every tool result of a thread. Rows the `CHECK` admitted but no known
    /// status parses from are skipped: the schema is the guard, this read is
    /// not a second validator.
    pub fn tool_results_for_thread(&self, thread_id: &str) -> Vec<ToolResultRef> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT tool_call_id, status FROM tool_result WHERE thread_id = ?1 ORDER BY created_at",
            )
            .expect("result read must prepare");
        stmt.query_map([thread_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("result read must run")
        .filter_map(Result::ok)
        .filter_map(|(tool_call_id, status)| {
            status
                .parse::<ToolStatus>()
                .ok()
                .map(|parsed| ToolResultRef {
                    tool_call_id,
                    status: parsed,
                })
        })
        .collect()
    }

    /// One block whole: kind, payload, and thinking signature intact (D72).
    pub fn get_block_full(&self, id: &str) -> Option<FullBlock> {
        self.conn
            .query_row(
                "SELECT b.id, m.seq, m.role, b.seq, b.kind, b.payload, b.generation, b.signature \
                 FROM block b JOIN message m ON b.message_id = m.id WHERE b.id = ?1",
                [id],
                |row| {
                    Ok(FullBlock {
                        id: row.get(0)?,
                        message_seq: row.get(1)?,
                        role: row.get(2)?,
                        seq: row.get(3)?,
                        kind: row.get(4)?,
                        payload: row.get(5)?,
                        generation: row.get(6)?,
                        signature: row.get(7)?,
                    })
                },
            )
            .ok()
    }

    /// Close a turn mid-flight. Every open call without a result is recorded
    /// as `aborted` (D65); calls that already resolved are untouched, and no
    /// completed row is rewritten or removed (D68). Returns the counts.
    pub fn cancel_turn(
        &self,
        thread_id: &str,
        open: &[OpenCall],
    ) -> Result<CancelReport, StoreError> {
        let mut report = CancelReport {
            aborted: 0,
            already_resolved: 0,
        };
        for call in open {
            let exists: bool = self
                .conn
                .query_row(
                    "SELECT 1 FROM tool_result WHERE thread_id = ?1 AND tool_call_id = ?2",
                    rusqlite::params![thread_id, call.id],
                    |_| Ok(true),
                )
                .optional()?
                .is_some();
            if exists {
                report.already_resolved += 1;
                continue;
            }
            self.conn.execute(
                "INSERT INTO tool_result (id, thread_id, tool_call_id, tool_name, status, preview, output_bytes, created_at) VALUES (?1, ?2, ?3, ?4, 'aborted', ?5, 0, ?6)",
                rusqlite::params![
                    Store::new_id("tr"),
                    thread_id,
                    call.id,
                    call.name,
                    "cancelled by user before completion",
                    crate::now_ms(),
                ],
            )?;
            report.aborted += 1;
        }
        Ok(report)
    }
}
