//! Availability: which tools the model may use, per adapter (D94, D26).
//!
//! D94 supersedes frozen-tools on the Claude API: every tool rides the first
//! request's array (unavailable ones `defer_loading: true`), and the set
//! changes only via `tool_addition` / `tool_removal` system messages — never
//! a rewritten array, never a new thread. The OpenAI-compatible adapter keeps
//! the frozen array. A denied tool is absent from the serialised request on
//! both paths (D26): denied at first sight is never declared; denied later is
//! hidden by a `tool_removal` block because the sent array cannot be unsent.
//!
//! Tool-change system messages are append-only records: the store has no
//! update path on message/block (004), so they join the prefix retroactively
//! and cannot be moved, reworded, or deleted (D94).

use crate::registry::eight_definitions;
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Beta header gating mid-thread tool changes on the Claude API (D94).
pub const INLINE_TOOLS_BETA: &str = "inline-tools-2026-09-15";

/// Per-thread effective set: granted tools the model may use, denied tools it
/// must never see. Anything neither granted nor denied is declared deferred.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThreadToolState {
    pub granted: BTreeSet<String>,
    pub denied: BTreeSet<String>,
}

/// One tool as serialised for a request.
#[derive(Debug, Clone, PartialEq)]
pub struct MaterializedTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub deferred: bool,
}

/// The full availability surface for both adapters.
#[derive(Debug, Clone, PartialEq)]
pub struct Availability {
    /// Claude API: all eight minus denied-at-first-sight, frozen after.
    pub anthropic_tools: Vec<MaterializedTool>,
    /// OpenAI-compatible: granted only, frozen after.
    pub openai_tools: Vec<MaterializedTool>,
    /// Grants since `prev`, as `tool_addition` blocks.
    pub additions: Vec<Value>,
    /// Revocations and fresh denials since `prev`, as `tool_removal` blocks.
    pub removals: Vec<Value>,
    /// `role: "system"` messages carrying the blocks, in order.
    pub system_messages: Vec<Value>,
    /// Beta headers the request must carry when availability is in play.
    pub beta_headers: Vec<String>,
}

fn visible(state: &ThreadToolState) -> BTreeSet<String> {
    state.granted.difference(&state.denied).cloned().collect()
}

fn addition_block(name: &str) -> Value {
    json!({"type": "tool_addition", "name": name})
}

fn removal_block(name: &str) -> Value {
    json!({"type": "tool_removal", "name": name})
}

fn system_message(block: &Value) -> Value {
    json!({"role": "system", "content": [block]})
}

/// Compute the availability surface. `prev` is the previous call's output;
/// `None` declares the first request. The tools arrays are frozen after the
/// first call — every later change is a block, never a rewrite.
/// `compact` is host-driven only and never serialised (D14).
#[must_use]
pub fn materialize(prev: Option<&Availability>, state: &ThreadToolState) -> Availability {
    let now_visible = visible(state);
    let is_model_callable = |name: &str| name != "compact";
    let anthropic_tools = prev.map_or_else(
        || {
            eight_definitions()
                .into_iter()
                .filter(|d| is_model_callable(&d.name))
                .filter(|d| !state.denied.contains(&d.name))
                .map(|d| MaterializedTool {
                    deferred: !now_visible.contains(&d.name),
                    name: d.name,
                    description: d.description,
                    input_schema: d.input_schema,
                })
                .collect()
        },
        |p| p.anthropic_tools.clone(),
    );
    let openai_tools = prev.map_or_else(
        || {
            eight_definitions()
                .into_iter()
                .filter(|d| is_model_callable(&d.name))
                .filter(|d| now_visible.contains(&d.name))
                .map(|d| MaterializedTool {
                    deferred: false,
                    name: d.name,
                    description: d.description,
                    input_schema: d.input_schema,
                })
                .collect()
        },
        |p| p.openai_tools.clone(),
    );

    let mut additions = Vec::new();
    let mut removals = Vec::new();
    let mut system_messages = Vec::new();
    if let Some(p) = prev {
        let prev_visible: BTreeSet<String> = {
            // Reconstruct: declared non-deferred names plus names added since.
            let mut v: BTreeSet<String> = p
                .anthropic_tools
                .iter()
                .filter(|t| !t.deferred)
                .map(|t| t.name.clone())
                .collect();
            for a in &p.additions {
                if let Some(n) = a.get("name").and_then(|n| n.as_str()) {
                    v.insert(n.to_string());
                }
            }
            for r in &p.removals {
                if let Some(n) = r.get("name").and_then(|n| n.as_str()) {
                    v.remove(n);
                }
            }
            v
        };
        let mut new_grants: Vec<String> = now_visible.difference(&prev_visible).cloned().collect();
        new_grants.sort();
        let mut new_losses: Vec<String> = prev_visible.difference(&now_visible).cloned().collect();
        new_losses.sort();
        // Fresh denials of already-declared tools hide behind removals: the
        // sent array cannot be unsent.
        for name in &new_grants {
            let block = addition_block(name);
            system_messages.push(system_message(&block));
            additions.push(block);
        }
        for name in &new_losses {
            let block = removal_block(name);
            system_messages.push(system_message(&block));
            removals.push(block);
        }
    }

    Availability {
        anthropic_tools,
        openai_tools,
        additions,
        removals,
        system_messages,
        beta_headers: vec![INLINE_TOOLS_BETA.to_string()],
    }
}
