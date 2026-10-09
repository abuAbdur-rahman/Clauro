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
use clauro_core::{Effect, PermissionRule, ToolContext, ToolOutcome, ToolStatus};
use clauro_store::transcript::OpenCall;
use clauro_store::{MessageRole, NewBlock, NewMessage, NewToolResult, NewUsage, Store, StoreError};
use clauro_tools::{
    bound_output, resolve, resolve_answer, AnswerResolution, ApprovalError, ApprovalQueue,
    IncomingCall, MaterializedTool, QuestionGate, Registry, INLINE_TOOLS_BETA, QUESTION_REFUSAL,
};
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
/// HTTP here.
///
/// `step` takes a **sink** and calls it once per event as the event is
/// produced, then returns the whole step as well. Both halves are deliberate:
///
/// - The sink is what makes a turn *stream*. Returning the vector alone means
///   nothing is observable until the provider has finished, which no renderer
///   can draw from.
/// - The returned vector is still what gets persisted, so persistence sees one
///   complete step exactly as before. A caller that ignores the sink observes
///   the old behaviour, unchanged.
///
/// An implementation must call the sink for every event it returns, in order.
/// Returning an event without sinking it hides text from the view; sinking one
/// it does not return would persist nothing. `tests/streaming.rs` pins both.
pub trait Exchange {
    fn step(
        &mut self,
        request: &BuiltRequest,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<Vec<NormalisedEvent>, ExchangeFailure>;
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
    /// Permission rules consulted on every dispatch (D26). Empty means the
    /// default: everything dispatchable.
    pub rules: Vec<PermissionRule>,
}

/// How a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEnd {
    EndTurn,
    Stopped,
    TransportError,
    /// An ask-effect call was held for approval. Nothing dispatched for it;
    /// the driver approves and the next turn resumes with it.
    AwaitingApproval,
    /// A sole, valid `question` call was asked and persisted as a card. The
    /// turn pauses here — re-sending would echo the card back as if answered.
    /// The driver answers via `answer_question` and resumes the turn.
    AwaitingAnswer,
}

/// What a turn did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnReport {
    pub end: TurnEnd,
    pub dispatched: Vec<String>,
    pub assistant_messages: usize,
    pub stop_offer: Option<StopOffer>,
    /// Held call ids awaiting approval, in hold order.
    pub pending_approvals: Vec<String>,
    /// The question call id awaiting an answer, if `end` is `AwaitingAnswer`.
    pub pending_question: Option<String>,
}

/// Why an answer was refused. Every variant is user-visible; the model never
/// sees these — by answer time the model is paused, not listening.
///
/// The resume half (provider, key, slot) mirrors `TurnError` deliberately:
/// one command, one matchable error type for the view.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AnswerError {
    /// Blank thread, call, or provider id.
    BadInput { reason: String },
    /// Another turn holds this thread; stop it before answering into one.
    Busy { thread_id: String },
    /// The provider id has no row: never configured, or removed since.
    NoProvider { provider: String },
    /// Configured, but this build cannot speak its wire yet (same rule as
    /// `TurnError::UnsupportedProvider`: key + models work, turns need the
    /// request translator).
    UnsupportedProvider { provider: String },
    /// No stored key for the provider.
    NoKey { provider: String },
    /// No unanswered card with this call id on this thread.
    NoSuchCard(String),
    /// The card already has its one result. I1 pairs exactly once.
    AlreadyAnswered(String),
    /// The answer fails the card's own rules (unknown option, blank, closed
    /// card with free text off).
    Invalid(clauro_tools::QuestionError),
    /// Storage or lock failure, with the message. A string rather than the
    /// store error: `StoreError` wraps the engine and is neither cloneable
    /// nor serializable, and this type crosses the Tauri boundary.
    Store { reason: String },
}

impl std::fmt::Display for AnswerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadInput { reason } => write!(f, "bad answer input: {reason}"),
            Self::Busy { thread_id } => write!(f, "a turn is already running on {thread_id}"),
            Self::NoProvider { provider } => write!(
                f,
                "provider {provider} is not configured; add it before answering"
            ),
            Self::UnsupportedProvider { provider } => write!(
                f,
                "provider {provider} is configured but live turns need the OpenAI request translator, which is not built yet"
            ),
            Self::NoKey { provider } => write!(
                f,
                "no API key for {provider} in the keychain; add one before answering"
            ),
            Self::NoSuchCard(id) => write!(f, "no unanswered question {id}"),
            Self::AlreadyAnswered(id) => write!(f, "question {id} already answered"),
            Self::Invalid(e) => write!(f, "answer not accepted: {e}"),
            Self::Store { reason } => write!(f, "store error: {reason}"),
        }
    }
}

impl std::error::Error for AnswerError {}

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
    Approval(clauro_tools::ApprovalError),
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

/// The loop: per-thread queues, stop flags, approvals, question gates, and
/// the driver.
pub struct TurnLoop {
    queues: HashMap<String, ThreadQueue>,
    stops: HashMap<String, Arc<AtomicBool>>,
    approvals: HashMap<String, ApprovalQueue>,
    gates: HashMap<String, QuestionGate>,
}

/// One string field out of a stored JSON payload. `None` covers corrupt
/// payloads and missing fields alike: callers treat both as "no such row",
/// never as a reason to invent one.
fn payload_field(payload: &str, key: &str) -> Option<String> {
    serde_json::from_str::<Value>(payload)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

impl TurnLoop {
    #[must_use]
    pub fn new() -> Self {
        Self {
            queues: HashMap::new(),
            stops: HashMap::new(),
            approvals: HashMap::new(),
            gates: HashMap::new(),
        }
    }

    /// The thread's question gate, shared with the `question` handler when the
    /// driver binds it via `register_question_with_gate`. Same `Arc` every
    /// call: the loop and the handler observe one turn state.
    pub fn question_gate(&mut self, thread_id: &str) -> QuestionGate {
        self.gates.entry(thread_id.to_string()).or_default().clone()
    }

    fn approvals_for(&mut self, thread_id: &str) -> &mut ApprovalQueue {
        self.approvals.entry(thread_id.to_string()).or_default()
    }

    fn gate_for(&mut self, thread_id: &str) -> QuestionGate {
        self.question_gate(thread_id)
    }

    /// Record one dispatch on the thread's question gate. The question
    /// handler records itself; everything else is recorded here, so the gate
    /// observes the whole turn (D101).
    fn gate_note(&mut self, thread_id: &str, name: &str) {
        self.question_gate(thread_id).note_call(name);
    }

    /// Dispatch with output bounding on the way out (D27): the full preview
    /// text goes to storage and the row keeps the bounded slice plus both
    /// re-readable paths. A bounding failure keeps the raw preview so the
    /// turn continues — storage trouble must not kill a good result.
    fn dispatch_bounded(
        &self,
        registry: &Registry,
        material: &clauro_tools::Materialization,
        ctx: &ToolContext,
        workspace_dir: &Path,
        pending: &PendingTool,
    ) -> ToolOutcome {
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
        match outcome {
            ToolOutcome::Ok { preview, .. } => {
                match bound_output(workspace_dir, &pending.id, &preview) {
                    Ok(bounded) => ToolOutcome::Ok {
                        preview: bounded.preview,
                        preview_path: Some(bounded.preview_path.to_string_lossy().into_owned()),
                        full_path: Some(bounded.full_path.to_string_lossy().into_owned()),
                    },
                    Err(_) => ToolOutcome::Ok {
                        preview,
                        preview_path: None,
                        full_path: None,
                    },
                }
            }
            other => other,
        }
    }

    /// Approve a held call. It dispatches at the start of the next turn, in
    /// hold order with any other approved siblings.
    pub fn approve_call(&mut self, thread_id: &str, id: &str) -> Result<(), ApprovalError> {
        self.approvals_for(thread_id).approve(id)?;
        Ok(())
    }

    /// Answer an awaiting question card (009, D42). Validates through    /// `resolve_answer` — the card's own rules, so an option outside the card
    /// or a blank answer fails here, loudly — then persists the answer as the
    /// call's one `tool_result` row plus its block. I1 pairs exactly once:
    /// a second answer finds the sibling result and fails `AlreadyAnswered`.
    /// The driver resumes the turn afterwards (usually `continue_turn`); this
    /// method only records the answer, never drives.
    pub fn answer_question(
        &self,
        store: &Store,
        thread_id: &str,
        tool_call_id: &str,
        answer: &str,
    ) -> Result<AnswerResolution, AnswerError> {
        let blocks = store.blocks_for_thread(thread_id);
        let card = blocks
            .iter()
            .find(|b| {
                b.kind == "question_card"
                    && payload_field(&b.payload, "id") == Some(tool_call_id.to_string())
            })
            .ok_or_else(|| AnswerError::NoSuchCard(tool_call_id.to_string()))?;
        if blocks.iter().any(|b| {
            b.kind == "tool_result"
                && payload_field(&b.payload, "tool_use_id") == Some(tool_call_id.to_string())
        }) {
            return Err(AnswerError::AlreadyAnswered(tool_call_id.to_string()));
        }
        let card_value: Value = serde_json::from_str(&card.payload)
            .map_err(|_| AnswerError::NoSuchCard(tool_call_id.to_string()))?;
        let resolution = resolve_answer(&card_value, answer).map_err(AnswerError::Invalid)?;
        let use_block = blocks.iter().find(|b| {
            b.kind == "tool_use"
                && payload_field(&b.payload, "id") == Some(tool_call_id.to_string())
        });
        let msg_id = match use_block {
            Some(b) => store
                .message_id_for_block(&b.id)
                .map_err(|e| AnswerError::Store {
                    reason: e.to_string(),
                })?,
            None => {
                return Err(AnswerError::NoSuchCard(tool_call_id.to_string()));
            }
        };
        store
            .insert_tool_result(NewToolResult {
                id: Store::new_id("tr"),
                thread_id: thread_id.to_string(),
                tool_call_id: tool_call_id.to_string(),
                tool_name: "question".to_string(),
                status: ToolStatus::Ok,
                preview: resolution.resolved.clone(),
                preview_path: None,
                full_path: None,
                output_bytes: resolution.resolved.len() as i64,
                created_at: now_ms(),
            })
            .map_err(|e| AnswerError::Store {
                reason: e.to_string(),
            })?;
        self.insert_tool_block(
            store,
            &msg_id,
            &PendingTool {
                index: 0,
                id: tool_call_id.to_string(),
                name: "question".to_string(),
                input: String::new(),
            },
            &ToolOutcome::Ok {
                preview: resolution.resolved.clone(),
                preview_path: None,
                full_path: None,
            },
        )
        .map_err(|e| match e {
            LoopError::Store(s) => AnswerError::Store {
                reason: s.to_string(),
            },
            _ => AnswerError::Store {
                reason: "answer block write failed".to_string(),
            },
        })?;
        Ok(resolution)
    }

    /// Reject a held call: a typed `error` result row, loop continues, the
    /// held row stays rejected and nothing else is touched (D109).
    pub fn reject_call(
        &mut self,
        store: &Store,
        thread_id: &str,
        id: &str,
    ) -> Result<(), ApprovalError> {
        let outcome = self.approvals_for(thread_id).reject(id)?;
        let (status, message) = match &outcome {
            ToolOutcome::Rejected { message } => (ToolStatus::Rejected, message.clone()),
            ToolOutcome::Error { message } => (ToolStatus::Error, message.clone()),
            _ => (ToolStatus::Error, String::new()),
        };
        store
            .insert_tool_result(NewToolResult {
                id: Store::new_id("tr"),
                thread_id: thread_id.to_string(),
                tool_call_id: id.to_string(),
                tool_name: String::new(),
                status,
                preview: message,
                preview_path: None,
                full_path: None,
                output_bytes: 0,
                created_at: now_ms(),
            })
            .map_err(|e| ApprovalError::Store(e.to_string()))?;
        Ok(())
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
    ///
    /// `sink` receives every provider event as it arrives; pass `&mut |_| {}`
    /// to discard it and get a non-streaming turn.
    pub fn run_turn(
        &mut self,
        store: &Store,
        registry: &mut Registry,
        exchange: &mut impl Exchange,
        plan: TurnPlan<'_>,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<TurnReport, LoopError> {
        self.check_prefix(store, plan.thread_id, plan.prepared)?;
        // Fresh turn, fresh flag: a stop belongs to the turn it interrupted.
        self.stop_flag(plan.thread_id)
            .store(false, Ordering::SeqCst);

        let turn_id = Store::new_id("turn");
        let mut seq = max_seq(store, plan.thread_id) + 1;
        insert_text_message(
            store,
            plan.thread_id,
            MessageRole::User,
            seq,
            plan.user_text,
        )?;
        seq += 1;

        self.drive_turn(
            store,
            registry,
            exchange,
            plan.thread_id,
            plan.prepared,
            plan.workspace_dir,
            &turn_id,
            seq,
            sink,
        )
    }

    /// Continue a truncated turn (D106): same checks as `run_turn`, but no new
    /// user message — the assistant rows append to the open turn instead of a
    /// regenerated one.
    #[allow(clippy::too_many_arguments)]
    pub fn continue_turn(
        &mut self,
        store: &Store,
        registry: &mut Registry,
        exchange: &mut impl Exchange,
        thread_id: &str,
        prepared: &PreparedThread,
        workspace_dir: &Path,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<TurnReport, LoopError> {
        self.check_prefix(store, thread_id, prepared)?;
        self.stop_flag(thread_id).store(false, Ordering::SeqCst);

        let turn_id = Store::new_id("turn");
        let seq = max_seq(store, thread_id) + 1;
        self.drive_turn(
            store,
            registry,
            exchange,
            thread_id,
            prepared,
            workspace_dir,
            &turn_id,
            seq,
            sink,
        )
    }

    /// Regenerate the last answer (D99): re-reads the latest user text and
    /// runs it as a new turn. New rows only — history is never rewritten, and
    /// a thread with no user text fails typed instead of inventing one.
    #[allow(clippy::too_many_arguments)]
    pub fn regenerate_last(
        &mut self,
        store: &Store,
        registry: &mut Registry,
        exchange: &mut impl Exchange,
        thread_id: &str,
        prepared: &PreparedThread,
        workspace_dir: &Path,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<TurnReport, LoopError> {
        let text = last_user_text(store, thread_id)?;
        self.run_turn(
            store,
            registry,
            exchange,
            TurnPlan {
                thread_id,
                user_text: &text,
                prepared,
                workspace_dir,
            },
            sink,
        )
    }

    /// The D19 prefix check `run_turn` and `continue_turn` share: never extend
    /// a prefix the thread did not start with.
    fn check_prefix(
        &self,
        store: &Store,
        thread_id: &str,
        prepared: &PreparedThread,
    ) -> Result<(), LoopError> {
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
        Ok(())
    }

    /// The step loop both turn entries share, starting at `seq`.
    #[allow(clippy::too_many_arguments)]
    fn drive_turn(
        &mut self,
        store: &Store,
        registry: &mut Registry,
        exchange: &mut impl Exchange,
        thread_id: &str,
        prepared: &PreparedThread,
        workspace_dir: &Path,
        turn_id: &str,
        mut seq: i64,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<TurnReport, LoopError> {
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
            pending_approvals: Vec::new(),
            pending_question: None,
        };

        // Approved held calls dispatch first, in hold order, before any new
        // exchange step. They carry their own message: the tool_use blocks
        // they answer already sit in an earlier one.
        let resumed = self
            .approvals_for(thread_id)
            .drain_approved()
            .into_iter()
            .map(|h| PendingTool {
                index: 0,
                id: h.id,
                name: h.tool,
                input: h.input.to_string(),
            })
            .collect::<Vec<_>>();
        if !resumed.is_empty() {
            let msg_id = self.insert_assistant(store, thread_id, seq)?;
            seq += 1;
            report.assistant_messages += 1;
            for pending in &resumed {
                self.gate_note(thread_id, &pending.name);
                let outcome =
                    self.dispatch_bounded(registry, &material, &ctx, workspace_dir, pending);
                self.persist_result(store, thread_id, &msg_id, pending, &outcome)?;
                report.dispatched.push(pending.id.clone());
            }
        }

        loop {
            if self.stopped(thread_id) {
                report.end = TurnEnd::Stopped;
                break;
            }
            // One assistant message, one gate window (D42, D101).
            self.gate_for(thread_id).reset();
            let request = self.build_request(store, thread_id, prepared);
            let events = match exchange.step(&request, sink) {
                Ok(events) => events,
                Err(failure) => {
                    let msg_id = self.insert_assistant(store, thread_id, seq)?;
                    report.assistant_messages += 1;
                    self.insert_notice(store, &msg_id, 0, &failure.message)?;
                    report.end = TurnEnd::TransportError;
                    break;
                }
            };
            let msg_id = self.insert_assistant(store, thread_id, seq)?;
            seq += 1;
            report.assistant_messages += 1;
            let pendings = self.persist_step(store, thread_id, turn_id, &msg_id, &events)?;

            // D101 at the loop: a question beside any other call — or a second
            // question — in one message is refused upfront, whatever the order.
            let question_ids: Vec<&PendingTool> =
                pendings.iter().filter(|p| p.name == "question").collect();
            let mixed = question_ids.len() > 1 || (question_ids.len() == 1 && pendings.len() > 1);

            let mut dispatched_here = Vec::new();
            let mut halted = false;
            let mut held = false;
            for pending in &pendings {
                if self.stopped(thread_id) {
                    halted = true;
                    break;
                }
                if pending.name == "question" && mixed {
                    self.persist_result(
                        store,
                        thread_id,
                        &msg_id,
                        pending,
                        &ToolOutcome::Error {
                            message: QUESTION_REFUSAL.to_string(),
                        },
                    )?;
                    dispatched_here.push(pending.id.clone());
                    continue;
                }
                if pending.name != "question" {
                    self.gate_note(thread_id, &pending.name);
                }
                match resolve(&pending.name, &prepared.rules) {
                    Effect::Deny => {
                        self.persist_result(
                            store,
                            thread_id,
                            &msg_id,
                            pending,
                            &ToolOutcome::Error {
                                message: format!(
                                    "tool {} is not permitted by policy",
                                    pending.name
                                ),
                            },
                        )?;
                        dispatched_here.push(pending.id.clone());
                    }
                    Effect::Ask => {
                        let queue = self.approvals_for(thread_id);
                        queue
                            .hold_pending(&pending.id, &pending.name, pending_input(pending))
                            .map_err(LoopError::Approval)?;
                        report.pending_approvals.push(pending.id.clone());
                        held = true;
                        break;
                    }
                    Effect::Allow => {
                        let outcome = self.dispatch_bounded(
                            registry,
                            &material,
                            &ctx,
                            workspace_dir,
                            pending,
                        );
                        // A sole, valid question pauses the turn instead of
                        // persisting a result: re-sending would echo the card
                        // text back as if the user had answered (009, D42).
                        // Refusals (mixed/second/secret) are Errors and flow
                        // through the ordinary result path below.
                        if pending.name == "question" && matches!(outcome, ToolOutcome::Ok { .. }) {
                            match self.insert_question_card(store, &msg_id, pending) {
                                Ok(()) => {
                                    dispatched_here.push(pending.id.clone());
                                    report.pending_question = Some(pending.id.clone());
                                    report.end = TurnEnd::AwaitingAnswer;
                                    break;
                                }
                                // No prompt to show is a malformed card, not
                                // a pause: persist the refusal-shaped error.
                                Err(_) => {
                                    self.persist_result(
                                        store,
                                        thread_id,
                                        &msg_id,
                                        pending,
                                        &ToolOutcome::Error {
                                            message: QUESTION_REFUSAL.to_string(),
                                        },
                                    )?;
                                    dispatched_here.push(pending.id.clone());
                                    continue;
                                }
                            }
                        }
                        self.persist_result(store, thread_id, &msg_id, pending, &outcome)?;
                        dispatched_here.push(pending.id.clone());
                    }
                }
            }
            report.dispatched.extend(dispatched_here.iter().cloned());
            if report.end == TurnEnd::AwaitingAnswer {
                // The question is asked and persisted; re-sending now would
                // echo the card back as an answer. The driver answers via
                // `answer_question` and resumes the turn.
                break;
            }
            if held {
                // The turn pauses for a decision; nothing dispatched for the
                // held call, so nothing to close. Approved calls resume on a
                // later turn.
                report.end = TurnEnd::AwaitingApproval;
                break;
            }
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
                // A failed cancel is a loud turn failure, not a silent gap:
                // the D65/D68 paths must not lose data without a trace.
                store
                    .cancel_turn(thread_id, &open)
                    .map_err(LoopError::Store)?;
                for pending in &pendings {
                    if !dispatched_here.contains(&pending.id) {
                        self.insert_tool_block(
                            store,
                            &msg_id,
                            pending,
                            &ToolOutcome::Aborted {
                                message: "cancelled by user before completion".to_string(),
                            },
                        )?;
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
                    )?;
                    block_seq += 1;
                }
                NormalisedEvent::Stop { .. } | NormalisedEvent::Ping => {}
                NormalisedEvent::Ignored { raw_type } => {
                    // The adapter could not map this event, but the provider
                    // sent it — dropping it renders a plausible-looking wrong
                    // transcript, so it becomes a visible notice instead (005:
                    // degrade visibly, never silently).
                    self.insert_notice(
                        store,
                        msg_id,
                        block_seq,
                        &format!(
                            "provider sent {raw_type}, which this app does not render; continuing"
                        ),
                    )?;
                    block_seq += 1;
                }
                NormalisedEvent::Error { message } => {
                    self.insert_notice(store, msg_id, block_seq, message)?;
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

    /// Persist a question card for a sole, valid `question` call. The tool_use
    /// block already exists (written at `BlockStop`); the card carries what
    /// the view needs to ask: prompt, options, free-text allowance. Returns
    /// `Err(())` when the input has no prompt — a card with nothing to ask is
    /// malformed, and the caller falls back to a refusal result instead of
    /// pausing the turn on nothing.
    fn insert_question_card(
        &self,
        store: &Store,
        msg_id: &str,
        pending: &PendingTool,
    ) -> Result<(), ()> {
        let input: Value = serde_json::from_str(&pending.input).map_err(|_| ())?;
        let prompt = input
            .get("prompt")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or(())?;
        let options = input.get("options").cloned().unwrap_or(Value::Null);
        let allow_free = input
            .get("allowFreeText")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let seq = self.next_block_seq(store, msg_id);
        store
            .insert_block(NewBlock {
                id: Store::new_id("b"),
                message_id: msg_id.to_string(),
                seq,
                kind: "question_card".to_string(),
                payload: json!({
                    "id": pending.id,
                    "prompt": prompt,
                    "options": options,
                    "allowFreeText": allow_free,
                    "resolved": Value::Null,
                })
                .to_string(),
                boundary: None,
                is_summary: false,
                generation: 0,
                signature: None,
                dropped: false,
            })
            .map_err(|_| ())?;
        Ok(())
    }

    fn insert_tool_block(
        &self,
        store: &Store,
        msg_id: &str,
        pending: &PendingTool,
        outcome: &ToolOutcome,
    ) -> Result<(), LoopError> {
        let (status, preview) = match outcome {
            ToolOutcome::Ok { preview, .. } => ("ok", preview.clone()),
            ToolOutcome::Error { message } => ("error", message.clone()),
            ToolOutcome::Aborted { message } => ("aborted", message.clone()),
            ToolOutcome::Rejected { message } => ("rejected", message.clone()),
        };
        let seq = self.next_block_seq(store, msg_id);
        store
            .insert_block(NewBlock {
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
            })
            .map_err(LoopError::Store)
    }

    fn insert_notice(
        &self,
        store: &Store,
        msg_id: &str,
        seq: i64,
        text: &str,
    ) -> Result<(), LoopError> {
        store
            .insert_block(NewBlock {
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
            })
            .map_err(LoopError::Store)
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
        self.insert_tool_block(store, msg_id, pending, outcome)?;
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

/// Rebuild the input value a held call was dispatched with.
fn pending_input(pending: &PendingTool) -> Value {
    serde_json::from_str(&pending.input).unwrap_or(Value::String(pending.input.clone()))
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

/// Latest user text in surface order, for `regenerate_last` (D99). Reads the
/// stored rows — never the in-flight plan — so a regenerated turn repeats what
/// the user actually said. Absent or unreadable rows are a typed store error,
/// never an invented prompt.
fn last_user_text(store: &Store, thread_id: &str) -> Result<String, LoopError> {
    store
        .blocks_for_thread(thread_id)
        .into_iter()
        .filter(|b| b.role == "user" && b.kind == "text")
        .max_by_key(|b| b.message_seq)
        .and_then(|b| {
            serde_json::from_str::<Value>(&b.payload)
                .ok()
                .and_then(|v| v.get("text")?.as_str().map(str::to_string))
        })
        .ok_or_else(|| {
            LoopError::Store(clauro_store::StoreError::NotFound(format!(
                "no readable user text on thread {thread_id}"
            )))
        })
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
    use std::collections::{BTreeMap, HashSet};
    let mut by_message: BTreeMap<(i64, String), BlockRows> = BTreeMap::new();
    for b in store.blocks_for_thread(thread_id) {
        by_message
            .entry((b.message_seq, b.role.clone()))
            .or_default()
            .push((b.seq, b.kind, b.payload, b.signature));
    }
    // Calls with answers, thread-wide: a `question` tool_use without its
    // result is awaiting the user, not model history. Re-sending it would be
    // a malformed request (Anthropic requires a result per use) and would
    // echo the card as if answered — the exact failure 009 exists to prevent.
    // Only `question` can be unpaired (every other dispatch persists its
    // result synchronously), so only it is skipped.
    let mut answered: HashSet<String> = HashSet::new();
    for ((_, _), blocks) in by_message.iter() {
        for (_, kind, payload, _) in blocks {
            if kind == "tool_result" {
                if let Some(id) = serde_json::from_str::<Value>(payload).ok().and_then(|v| {
                    v.get("tool_use_id")
                        .and_then(|t| t.as_str())
                        .map(str::to_string)
                }) {
                    answered.insert(id);
                }
            }
        }
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
                    "tool_use" => {
                        let id = v.get("id").and_then(|t| t.as_str()).unwrap_or("");
                        let name = v.get("name").and_then(|t| t.as_str()).unwrap_or("");
                        // Skip an unanswered question: it is awaiting the
                        // user, and re-sending it is both malformed and a
                        // lie about having been answered (see above).
                        if name == "question" && !answered.contains(id) {
                            continue;
                        }
                        content.push(json!({
                            "type": "tool_use",
                            "id": v.get("id"),
                            "name": v.get("name"),
                            "input": v.get("input").and_then(|i| i.as_str()).and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or(Value::Object(Default::default())),
                        }))
                    }
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
