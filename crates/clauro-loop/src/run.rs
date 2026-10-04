//! The serial turn loop (D85, D55, D65, D68, D98, D105).
//!
//! One step at a time: build the request from the stored transcript,
//! exchange it for provider events, persist every block, dispatch closed
//! `tool_use` blocks serially through the registry, re-send until `end_turn`
//! or stop. Parallel calls, retries, and budget caps are v2's general loop
//! and are the one thing v1 omits.
//!
//! Payload shapes (ours, documented here because the store keeps them):
//! - text: `{"text"}` · thinking: `{"text","display"}` + signature column
//! - tool_use: `{"id","name","input"}` (fragments concatenated verbatim)
//! - tool_result: `{"tool_use_id","status","preview"}`
//! - notice: `{"level","text"}` — host-side rows (transport failures, drops)
//!   that never re-send to the provider.
//!
//! Stop granularity: the exchange step is atomic, so a stop lands between
//! steps and between serial dispatches — never inside a handler call. Calls
//! still open at that point close as `aborted` through `cancel_turn` (006).

use crate::queue::{QueuedItem, StopOffer, ThreadQueue};
use clauro_core::{ToolContext, ToolOutcome, ToolStatus};
use clauro_store::transcript::OpenCall;
use clauro_store::{MessageRole, NewBlock, NewMessage, NewToolResult, NewUsage, Store, StoreError};
use clauro_tools::{IncomingCall, MaterializedTool, Registry, INLINE_TOOLS_BETA};
use clauro_transport::{
    build_normal_request, BuiltRequest, InboundKind, NormalBuildInput, NormalisedEvent,
    ThinkingConfig, ToolHeader,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// A provider failure for one step. The loop records it and ends the turn —
/// it never hangs on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExchangeFailure {
    pub message: String,
}

/// One model response per call. Test doubles script steps; the shell wires
/// HTTP here in Phase 5.
pub trait Exchange {
    fn step(&mut self, request: &BuiltRequest) -> Result<Vec<NormalisedEvent>, ExchangeFailure>;
}

/// Everything the loop needs that is fixed per thread.
pub struct PreparedThread {
    pub system_text: String,
    pub frozen_hash: String,
    pub model: String,
    pub max_tokens: u32,
    /// Materialised availability surface. `compact` never reaches the schema.
    pub tools: Vec<MaterializedTool>,
    pub thinking_budget: u32,
}

/// How a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEnd {
    EndTurn,
    Stopped,
    TransportError,
}

/// What a turn did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnReport {
    pub end: TurnEnd,
    pub dispatched: Vec<String>,
    pub assistant_messages: usize,
    pub stop_offer: Option<StopOffer>,
}

/// Why a turn refused to run.
#[derive(Debug)]
pub enum LoopError {
    /// The thread's frozen surface is not the one prepared: never extend a
    /// prefix the thread did not start with (D19).
    PrefixChanged {
        want: String,
        got: String,
    },
    ThreadMissing(String),
    Store(StoreError),
}

/// Everything varying per turn. Bundles what `run_turn` needs beyond the
/// long-lived handles, so the driver signature stays readable.
pub struct TurnPlan<'a> {
    pub thread_id: &'a str,
    pub user_text: &'a str,
    pub prepared: &'a PreparedThread,
    pub workspace_dir: &'a Path,
}

/// A tool_use block closed this step, awaiting serial dispatch.
struct PendingTool {
    index: u32,
    id: String,
    name: String,
    input: String,
}

/// One provider block being accumulated within a step.
struct OpenBlock {
    kind: InboundKind,
    text: String,
    signature: String,
    tool: Option<ToolHeader>,
}

/// The loop: per-thread queues, stop flags, and the driver.
pub struct TurnLoop {
    queues: HashMap<String, ThreadQueue>,
    stops: HashMap<String, Arc<AtomicBool>>,
}

impl TurnLoop {
    #[must_use]
    pub fn new() -> Self {
        Self {
            queues: HashMap::new(),
            stops: HashMap::new(),
        }
    }

    fn queue_for(&mut self, thread_id: &str) -> &mut ThreadQueue {
        self.queues.entry(thread_id.to_string()).or_default()
    }

    /// Stop flag for a thread, shared with in-flight work.
    pub fn stop_flag(&mut self, thread_id: &str) -> Arc<AtomicBool> {
        self.stops
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    fn stopped(&self, thread_id: &str) -> bool {
        self.stops
            .get(thread_id)
            .is_some_and(|f| f.load(Ordering::SeqCst))
    }

    /// Composer sent while a turn runs: appends, never blocks (D98).
    pub fn send_while_busy(&mut self, thread_id: &str, text: &str) -> String {
        self.queue_for(thread_id).enqueue(text)
    }

    /// User stop: halts generation. Offers drain-or-discard exactly when
    /// unsent input waits (D98).
    pub fn stop(&mut self, thread_id: &str) -> Option<StopOffer> {
        self.stop_flag(thread_id).store(true, Ordering::SeqCst);
        self.queues.get(thread_id).and_then(ThreadQueue::stop_offer)
    }

    /// Discard unsent input only. Completed rows are never touched (D68).
    pub fn discard_unsent(&mut self, thread_id: &str) -> usize {
        self.queues
            .get_mut(thread_id)
            .map_or(0, ThreadQueue::discard_unsent)
    }

    /// Next queued turn's input, if the loop is idle. One item, never merged.
    pub fn drain_next(&mut self, thread_id: &str) -> Option<QueuedItem> {
        self.queues.get_mut(thread_id)?.drain_next()
    }

    /// Chip: drop one queued item.
    pub fn chip_remove(&mut self, thread_id: &str, id: &str) -> bool {
        self.queues.get_mut(thread_id).is_some_and(|q| q.remove(id))
    }

    /// Chip: reword one queued item.
    pub fn chip_edit(&mut self, thread_id: &str, id: &str, text: &str) -> bool {
        self.queues
            .get_mut(thread_id)
            .is_some_and(|q| q.edit(id, text))
    }

    /// Chip: extract one item without draining the rest, and stop generation
    /// so the caller can send it immediately (D105).
    pub fn send_now(&mut self, thread_id: &str, id: &str) -> Option<QueuedItem> {
        let item = self.queues.get_mut(thread_id)?.send_now(id)?;
        self.stop_flag(thread_id).store(true, Ordering::SeqCst);
        Some(item)
    }

    /// Run one turn to `end_turn`, stop, or transport failure.
    pub fn run_turn(
        &mut self,
        store: &Store,
        registry: &mut Registry,
        exchange: &mut impl Exchange,
        plan: TurnPlan<'_>,
    ) -> Result<TurnReport, LoopError> {
        let thread_id = plan.thread_id;
        let prepared = plan.prepared;
        let workspace_dir = plan.workspace_dir;
        let thread = store
            .get_thread(thread_id)
            .map_err(LoopError::Store)?
            .ok_or_else(|| LoopError::ThreadMissing(thread_id.to_string()))?;
        if thread.system_frozen != prepared.frozen_hash {
            return Err(LoopError::PrefixChanged {
                want: prepared.frozen_hash.clone(),
                got: thread.system_frozen,
            });
        }
        // Fresh turn, fresh flag: a stop belongs to the turn it interrupted.
        self.stop_flag(thread_id).store(false, Ordering::SeqCst);

        let turn_id = Store::new_id("turn");
        let mut seq = max_seq(store, thread_id) + 1;
        insert_text_message(store, thread_id, MessageRole::User, seq, plan.user_text)?;
        seq += 1;

        let material = registry.materialize();
        let ctx = ToolContext {
            thread_id: thread_id.to_string(),
            call_id: String::new(),
            workspace_dir: workspace_dir.to_path_buf(),
        };
        let mut report = TurnReport {
            end: TurnEnd::EndTurn,
            dispatched: Vec::new(),
            assistant_messages: 0,
            stop_offer: None,
        };

        loop {
            if self.stopped(thread_id) {
                report.end = TurnEnd::Stopped;
                break;
            }
            let request = self.build_request(store, thread_id, prepared);
            let events = match exchange.step(&request) {
                Ok(events) => events,
                Err(failure) => {
                    let msg_id = self.insert_assistant(store, thread_id, seq)?;
                    report.assistant_messages += 1;
                    self.insert_notice(store, &msg_id, 0, &failure.message);
                    report.end = TurnEnd::TransportError;
                    break;
                }
            };
            let msg_id = self.insert_assistant(store, thread_id, seq)?;
            seq += 1;
            report.assistant_messages += 1;
            let pendings = self.persist_step(store, thread_id, &turn_id, &msg_id, &events)?;

            let mut dispatched_here = Vec::new();
            let mut halted = false;
            for pending in &pendings {
                if self.stopped(thread_id) {
                    halted = true;
                    break;
                }
                let outcome = registry.dispatch(
                    &IncomingCall {
                        name: pending.name.clone(),
                        input: serde_json::from_str(&pending.input)
                            .unwrap_or(Value::String(pending.input.clone())),
                        epoch: material.epoch,
                    },
                    &ToolContext {
                        call_id: pending.id.clone(),
                        ..ctx.clone()
                    },
                );
                self.persist_result(store, thread_id, &msg_id, pending, &outcome)?;
                dispatched_here.push(pending.id.clone());
            }
            report.dispatched.extend(dispatched_here.iter().cloned());
            if halted {
                // Calls still open close as aborted; resolved ones are
                // untouched, completed rows stay (D65, D68).
                let open: Vec<OpenCall> = pendings
                    .iter()
                    .filter(|p| !dispatched_here.contains(&p.id))
                    .map(|p| OpenCall {
                        id: p.id.clone(),
                        name: p.name.clone(),
                    })
                    .collect();
                let _ = store.cancel_turn(thread_id, &open);
                for pending in &pendings {
                    if !dispatched_here.contains(&pending.id) {
                        self.insert_tool_block(
                            store,
                            &msg_id,
                            pending,
                            &ToolOutcome::Aborted {
                                message: "cancelled by user before completion".to_string(),
                            },
                        );
                    }
                }
                report.end = TurnEnd::Stopped;
                break;
            }
            if pendings.is_empty() {
                break;
            }
        }

        if report.end == TurnEnd::Stopped {
            report.stop_offer = self.queues.get(thread_id).and_then(ThreadQueue::stop_offer);
        }
        Ok(report)
    }

    fn insert_assistant(
        &self,
        store: &Store,
        thread_id: &str,
        seq: i64,
    ) -> Result<String, LoopError> {
        let id = Store::new_id("m");
        store
            .insert_message(NewMessage {
                id: id.clone(),
                thread_id: thread_id.to_string(),
                seq,
                role: MessageRole::Assistant,
                created_at: now_ms(),
            })
            .map_err(LoopError::Store)?;
        Ok(id)
    }

    /// Persist one step's events; return the closed tool calls in order.
    fn persist_step(
        &self,
        store: &Store,
        thread_id: &str,
        turn_id: &str,
        msg_id: &str,
        events: &[NormalisedEvent],
    ) -> Result<Vec<PendingTool>, LoopError> {
        let mut open: BTreeMap<u32, OpenBlock> = BTreeMap::new();
        let mut order: Vec<u32> = Vec::new();
        let mut block_seq = self.next_block_seq(store, msg_id);
        let mut pendings: Vec<PendingTool> = Vec::new();

        for event in events {
            match event {
                NormalisedEvent::BlockStart { index, kind, tool } => {
                    open.insert(
                        *index,
                        OpenBlock {
                            kind: *kind,
                            text: String::new(),
                            signature: String::new(),
                            tool: tool.clone(),
                        },
                    );
                    order.push(*index);
                }
                NormalisedEvent::BlockDelta {
                    index,
                    text,
                    signature,
                } => {
                    if let Some(b) = open.get_mut(index) {
                        if let Some(t) = text {
                            b.text.push_str(t);
                        }
                        if let Some(s) = signature {
                            b.signature.push_str(s);
                        }
                    }
                }
                NormalisedEvent::BlockStop { index } => {
                    if let Some(b) = open.remove(index) {
                        self.insert_content_block(store, msg_id, block_seq, &b)?;
                        block_seq += 1;
                        if b.kind == InboundKind::ToolUse {
                            if let Some(tool) = b.tool {
                                pendings.push(PendingTool {
                                    index: *index,
                                    id: tool.id,
                                    name: tool.name,
                                    input: b.text,
                                });
                            }
                        }
                    }
                }
                NormalisedEvent::Usage { usage } => {
                    store
                        .insert_usage(NewUsage {
                            id: Store::new_id("u"),
                            thread_id: thread_id.to_string(),
                            message_id: Some(msg_id.to_string()),
                            run_id: turn_id.to_string(),
                            input_tokens: usage.billing_input_tokens as i64,
                            output_tokens: usage.billing_output_tokens as i64,
                            cache_read_tokens: 0,
                            cache_write_tokens: 0,
                            summary_tokens: 0,
                            summary_used_tokens: None,
                            iterations: None,
                            context_budget: None,
                            created_at: now_ms(),
                        })
                        .map_err(LoopError::Store)?;
                }
                NormalisedEvent::InputTransformed { dropped } => {
                    // Rows are append-only, so a drop cannot rewrite the
                    // thinking rows it covers — it surfaces as a notice in
                    // the same message (D71 without revisionism).
                    self.insert_notice(
                        store,
                        msg_id,
                        block_seq,
                        &format!("server dropped {dropped} thinking blocks"),
                    );
                    block_seq += 1;
                }
                NormalisedEvent::Stop { .. }
                | NormalisedEvent::Ping
                | NormalisedEvent::Ignored { .. } => {}
                NormalisedEvent::Error { message } => {
                    self.insert_notice(store, msg_id, block_seq, message);
                    block_seq += 1;
                }
            }
        }
        // Index order, not arrival order: serial dispatch is positional.
        pendings.sort_by_key(|p| p.index);
        Ok(pendings)
    }

    fn next_block_seq(&self, store: &Store, msg_id: &str) -> i64 {
        store
            .blocks_for_message(msg_id)
            .iter()
            .map(|b| b.seq)
            .max()
            .map_or(0, |m| m + 1)
    }

    fn insert_content_block(
        &self,
        store: &Store,
        msg_id: &str,
        seq: i64,
        block: &OpenBlock,
    ) -> Result<(), LoopError> {
        let (kind, payload, signature) = match block.kind {
            InboundKind::Text => (
                "text".to_string(),
                json!({"text": block.text}).to_string(),
                None,
            ),
            InboundKind::Thinking => (
                "thinking".to_string(),
                json!({"text": block.text, "display": "full"}).to_string(),
                Some(block.signature.clone()),
            ),
            InboundKind::ToolUse => {
                let tool = block.tool.clone().unwrap_or(ToolHeader {
                    id: String::new(),
                    name: String::new(),
                });
                (
                    "tool_use".to_string(),
                    json!({"id": tool.id, "name": tool.name, "input": block.text}).to_string(),
                    None,
                )
            }
            InboundKind::Compaction => (
                "compaction".to_string(),
                json!({"provider_block_id": block.text}).to_string(),
                None,
            ),
        };
        store
            .insert_block(NewBlock {
                id: Store::new_id("b"),
                message_id: msg_id.to_string(),
                seq,
                kind,
                payload,
                boundary: None,
                is_summary: false,
                generation: 0,
                signature,
                dropped: false,
            })
            .map_err(LoopError::Store)
    }

    fn insert_tool_block(
        &self,
        store: &Store,
        msg_id: &str,
        pending: &PendingTool,
        outcome: &ToolOutcome,
    ) {
        let (status, preview) = match outcome {
            ToolOutcome::Ok { preview, .. } => ("ok", preview.clone()),
            ToolOutcome::Error { message } => ("error", message.clone()),
            ToolOutcome::Aborted { message } => ("aborted", message.clone()),
            ToolOutcome::Rejected { message } => ("rejected", message.clone()),
        };
        let seq = self.next_block_seq(store, msg_id);
        let _ = store.insert_block(NewBlock {
            id: Store::new_id("b"),
            message_id: msg_id.to_string(),
            seq,
            kind: "tool_result".to_string(),
            payload: json!({"tool_use_id": pending.id, "status": status, "preview": preview})
                .to_string(),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: None,
            dropped: false,
        });
    }

    fn insert_notice(&self, store: &Store, msg_id: &str, seq: i64, text: &str) {
        let _ = store.insert_block(NewBlock {
            id: Store::new_id("b"),
            message_id: msg_id.to_string(),
            seq,
            kind: "notice".to_string(),
            payload: json!({"level": "error", "text": text}).to_string(),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: None,
            dropped: false,
        });
    }

    fn persist_result(
        &self,
        store: &Store,
        thread_id: &str,
        msg_id: &str,
        pending: &PendingTool,
        outcome: &ToolOutcome,
    ) -> Result<(), LoopError> {
        let (status, preview, preview_path, full_path) = match outcome {
            ToolOutcome::Ok {
                preview,
                preview_path,
                full_path,
            } => (
                ToolStatus::Ok,
                preview.clone(),
                preview_path.clone(),
                full_path.clone(),
            ),
            ToolOutcome::Error { message } => (ToolStatus::Error, message.clone(), None, None),
            ToolOutcome::Aborted { message } => (ToolStatus::Aborted, message.clone(), None, None),
            ToolOutcome::Rejected { message } => {
                (ToolStatus::Rejected, message.clone(), None, None)
            }
        };
        store
            .insert_tool_result(NewToolResult {
                id: Store::new_id("tr"),
                thread_id: thread_id.to_string(),
                tool_call_id: pending.id.clone(),
                tool_name: pending.name.clone(),
                status,
                preview: preview.clone(),
                preview_path,
                full_path,
                output_bytes: preview.len() as i64,
                created_at: now_ms(),
            })
            .map_err(LoopError::Store)?;
        self.insert_tool_block(store, msg_id, pending, outcome);
        Ok(())
    }

    /// Build this step's provider request from the stored transcript.
    fn build_request(
        &self,
        store: &Store,
        thread_id: &str,
        prepared: &PreparedThread,
    ) -> BuiltRequest {
        let tools: Vec<Value> = prepared
            .tools
            .iter()
            .filter(|t| t.name != "compact")
            .map(|t| {
                let mut v = json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                });
                if t.deferred {
                    v["defer_loading"] = Value::Bool(true);
                }
                v
            })
            .collect();
        let mut request = build_normal_request(NormalBuildInput {
            model: prepared.model.clone(),
            max_tokens: prepared.max_tokens,
            system: prepared.system_text.clone(),
            messages: assemble_messages(store, thread_id),
            tools,
            thinking: ThinkingConfig {
                budget_tokens: prepared.thinking_budget,
                display: None,
            },
            tool_choice: json!({"type": "auto"}),
        });
        // Availability rides the beta header (D94); comma-joined onto the
        // existing entry rather than a second header line.
        for (name, value) in request.headers.iter_mut() {
            if name == "anthropic-beta" && !value.contains(INLINE_TOOLS_BETA) {
                value.push(',');
                value.push_str(INLINE_TOOLS_BETA);
            }
        }
        request
    }
}

impl Default for TurnLoop {
    fn default() -> Self {
        Self::new()
    }
}

fn max_seq(store: &Store, thread_id: &str) -> i64 {
    store
        .blocks_for_thread(thread_id)
        .iter()
        .map(|b| b.message_seq)
        .max()
        .unwrap_or(0)
}

fn insert_text_message(
    store: &Store,
    thread_id: &str,
    role: MessageRole,
    seq: i64,
    text: &str,
) -> Result<(), LoopError> {
    let id = Store::new_id("m");
    store
        .insert_message(NewMessage {
            id: id.clone(),
            thread_id: thread_id.to_string(),
            seq,
            role,
            created_at: now_ms(),
        })
        .map_err(LoopError::Store)?;
    store
        .insert_block(NewBlock {
            id: Store::new_id("b"),
            message_id: id,
            seq: 0,
            kind: "text".to_string(),
            payload: json!({"text": text}).to_string(),
            boundary: None,
            is_summary: false,
            generation: 0,
            signature: None,
            dropped: false,
        })
        .map_err(LoopError::Store)
}

/// Rebuild provider messages from the stored transcript: user text, assistant
/// content with thinking signatures replayed (D72), tool pairs kept together.
/// Host-only `notice` rows never re-send.
/// Stored rows for one message: block seq, kind, payload, signature.
type BlockRows = Vec<(i64, String, String, Option<String>)>;

fn assemble_messages(store: &Store, thread_id: &str) -> Vec<Value> {
    use std::collections::BTreeMap;
    let mut by_message: BTreeMap<(i64, String), BlockRows> = BTreeMap::new();
    for b in store.blocks_for_thread(thread_id) {
        by_message
            .entry((b.message_seq, b.role.clone()))
            .or_default()
            .push((b.seq, b.kind, b.payload, b.signature));
    }
    let mut messages = Vec::new();
    for ((_, role), mut blocks) in by_message {
        blocks.sort_by_key(|(seq, _, _, _)| *seq);
        if role == "user" {
            let text: String = blocks
                .iter()
                .filter(|(_, kind, _, _)| kind == "text")
                .filter_map(|(_, _, payload, _)| {
                    serde_json::from_str::<Value>(payload)
                        .ok()
                        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
                })
                .collect::<Vec<_>>()
                .join("\n");
            messages.push(json!({"role": "user", "content": [{"type": "text", "text": text}]}));
        } else if role == "assistant" {
            let mut content = Vec::new();
            for (_, kind, payload, signature) in &blocks {
                let v: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
                match kind.as_str() {
                    "text" => content.push(
                        json!({"type": "text", "text": v.get("text").and_then(|t| t.as_str()).unwrap_or("")}),
                    ),
                    "thinking" => {
                        let mut block = json!({
                            "type": "thinking",
                            "thinking": v.get("text").and_then(|t| t.as_str()).unwrap_or(""),
                        });
                        if let Some(sig) = signature {
                            if !sig.is_empty() {
                                block["signature"] = Value::String(sig.clone());
                            }
                        }
                        content.push(block);
                    }
                    "tool_use" => content.push(json!({
                        "type": "tool_use",
                        "id": v.get("id"),
                        "name": v.get("name"),
                        "input": v.get("input").and_then(|i| i.as_str()).and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or(Value::Object(Default::default())),
                    })),
                    "tool_result" => content.push(json!({
                        "type": "tool_result",
                        "tool_use_id": v.get("tool_use_id"),
                        "content": v.get("preview").and_then(|t| t.as_str()).unwrap_or(""),
                    })),
                    _ => {}
                }
            }
            if !content.is_empty() {
                messages.push(json!({"role": "assistant", "content": content}));
            }
        } else {
            // System rows (tool-change records and friends) re-send as text.
            let text: String = blocks
                .iter()
                .filter_map(|(_, _, payload, _)| {
                    serde_json::from_str::<Value>(payload)
                        .ok()
                        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                messages.push(json!({"role": "system", "content": text}));
            }
        }
    }
    messages
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as i64
}
