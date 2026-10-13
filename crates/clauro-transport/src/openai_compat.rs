//! The OpenAI-compatible adapter: third-party chunks, same union.
//!
//! Everything else funnels through this adapter (D48), and the dialect varies
//! across providers in streaming deltas, tool-call framing,
//! reasoning-token fields, and in-band thought markers (Gemini's
//! `extra_content.google.thought` over `<thought>` markup — Tasks/005).
//! Two consequences:
//! - The parser is **stateful**: chat chunks carry no start markers, so the
//!   first sight of content / reasoning / a tool call synthesises the
//!   `BlockStart` the transcript pairs against.
//! - Anything unrecognised is `Ignored` with its object type preserved. The
//!   transcript layer (006) renders those as a visible notice — degrade
//!   visibly, never a plausible-looking wrong turn.

use crate::anthropic::{
    InboundKind, IterationUsage, NormalisedEvent, StreamParser, ToolHeader, UsageWire,
};
use crate::sse::RawSseEvent;
use serde_json::Value;
use std::collections::BTreeMap;

/// Stateful chunk parser behind the shared trait.
pub struct OpenAiParser {
    /// One counter for every synthesised start: text, thinking, and tool
    /// blocks share it, so index-keyed consumers never merge two blocks.
    next_index: u32,
    text_index: Option<u32>,
    thinking_index: Option<u32>,
    tool_index: BTreeMap<String, u32>,
    /// The most recent tool block, so a continuation carrying neither
    /// `index` nor `id` extends its own call (audit 12).
    last_tool: Option<u32>,
}

impl OpenAiParser {
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_index: 0,
            text_index: None,
            thinking_index: None,
            tool_index: BTreeMap::new(),
            last_tool: None,
        }
    }

    /// Hand out the next block index.
    fn fresh_index(&mut self) -> u32 {
        let index = self.next_index;
        self.next_index += 1;
        index
    }

    /// How many distinct tool blocks the map points at.
    fn distinct_tool_blocks(&self) -> usize {
        let mut blocks: Vec<u32> = self.tool_index.values().copied().collect();
        blocks.sort_unstable();
        blocks.dedup();
        blocks.len()
    }

    /// Stream one answer-text delta, synthesising the text block start once.
    fn emit_text(&mut self, out: &mut Vec<NormalisedEvent>, text: &str) {
        let index = match self.text_index {
            Some(i) => i,
            None => {
                let i = self.fresh_index();
                self.text_index = Some(i);
                out.push(NormalisedEvent::BlockStart {
                    index: i,
                    kind: InboundKind::Text,
                    tool: None,
                });
                i
            }
        };
        out.push(NormalisedEvent::BlockDelta {
            index,
            text: Some(text.to_string()),
            signature: None,
        });
    }

    /// Stream one reasoning delta, synthesising the thinking block start once.
    fn emit_thinking(&mut self, out: &mut Vec<NormalisedEvent>, text: &str) {
        let index = match self.thinking_index {
            Some(i) => i,
            None => {
                let i = self.fresh_index();
                self.thinking_index = Some(i);
                out.push(NormalisedEvent::BlockStart {
                    index: i,
                    kind: InboundKind::Thinking,
                    tool: None,
                });
                i
            }
        };
        out.push(NormalisedEvent::BlockDelta {
            index,
            text: Some(text.to_string()),
            signature: None,
        });
    }
}

/// Peel Gemini's in-band thought markers off one `delta.content`
/// (Tasks/005's recorded wire; the load-bearing fact for this adapter).
///
/// Returns `(thought, answer, closes)`: the thought portion with `<thought>`
/// stripped, the answer portion, and whether the thought region ends here.
/// The **marker** (`extra_content.google.thought`), not the markup alone,
/// decides which block text belongs to — and the shared closing delta
/// (`</thought>` plus the first answer characters in one frame) splits into
/// both. Splitting on tags alone, or ignoring the marker, renders reasoning
/// as answer: the plausible-looking wrong transcript D80 exists to prevent.
fn peel_thought(raw: &str, marked: bool, open: bool) -> (String, String, bool) {
    const OPEN: &str = "<thought>";
    const CLOSE: &str = "</thought>";
    if let Some(pos) = raw.find(CLOSE) {
        let (head, tail) = raw.split_at(pos);
        let after = &tail[CLOSE.len()..];
        if marked || open {
            let thought = head.strip_prefix(OPEN).unwrap_or(head);
            (thought.to_string(), after.to_string(), true)
        } else {
            // A stray close outside any thought: the markup is never
            // rendered, and the text around it is never lost.
            (String::new(), format!("{head}{after}"), false)
        }
    } else if marked {
        (
            raw.strip_prefix(OPEN).unwrap_or(raw).to_string(),
            String::new(),
            false,
        )
    } else if open {
        // Unmarked while a thought streams: the marker is authoritative —
        // this is answer text, and the thought ends here rather than
        // interleaving (each region stays contiguous on its own block).
        (String::new(), raw.to_string(), true)
    } else {
        (String::new(), raw.to_string(), false)
    }
}

impl Default for OpenAiParser {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamParser for OpenAiParser {
    fn feed(&mut self, event: &RawSseEvent) -> Vec<NormalisedEvent> {
        if event.data == "[DONE]" {
            return Vec::new(); // framing, not an event; stream end terminates
        }
        let data: Value = match serde_json::from_str(&event.data) {
            Ok(v) => v,
            Err(_) => {
                return vec![NormalisedEvent::Ignored {
                    raw_type: "unparseable".to_string(),
                }];
            }
        };
        let object = data.get("object").and_then(Value::as_str).unwrap_or("");
        if object != "chat.completion.chunk" {
            return vec![NormalisedEvent::Ignored {
                raw_type: if object.is_empty() {
                    "unknown-object".to_string()
                } else {
                    object.to_string()
                },
            }];
        }
        let mut out = Vec::new();
        for choice in data
            .get("choices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            // v1 dispatches serially: only the first choice is read.
            if choice.get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
                continue;
            }
            let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
            if let Some(raw) = delta.get("content").and_then(Value::as_str) {
                if !raw.is_empty() {
                    // Gemini's in-band thought marker decides which block the
                    // text belongs to (see `peel_thought`): read from the delta
                    // first — Tasks/005's recording is per-delta — with a
                    // choice-level fallback for servers that mark the choice.
                    let marked = delta
                        .pointer("/extra_content/google/thought")
                        .or_else(|| choice.pointer("/extra_content/google/thought"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let open = self.thinking_index.is_some();
                    let (thought, answer, closes) = peel_thought(raw, marked, open);
                    if !thought.is_empty() {
                        self.emit_thinking(&mut out, &thought);
                    }
                    if closes {
                        self.thinking_index = None;
                    }
                    if !answer.is_empty() {
                        self.emit_text(&mut out, &answer);
                    }
                }
            }
            if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
                self.emit_thinking(&mut out, reasoning);
            }
            if let Some(refusal) = delta.get("refusal").and_then(Value::as_str) {
                // A refusal is shown, not dropped: silence would read as a stall.
                self.emit_text(&mut out, refusal);
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    // Resolve the block this fragment belongs to: stream
                    // index first (continuations carry it alone), then id
                    // (id-first dialects open by id). A key seen for the
                    // first time must not open a second block for a call
                    // already open under the other key (audit 12).
                    let id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty());
                    let stream_index = call.get("index").and_then(Value::as_u64);
                    let index_key = stream_index.map(|i| format!("index:{i}"));
                    let mut block = index_key
                        .as_ref()
                        .and_then(|k| self.tool_index.get(k).copied())
                        .or_else(|| id.and_then(|id| self.tool_index.get(id).copied()));
                    if block.is_none() {
                        block = match (stream_index, id) {
                            // Neither key: a continuation of whatever call
                            // is currently open.
                            (None, None) => self.last_tool,
                            // Index-only, unseen: resume the sole open call
                            // (id-first dialect). With several calls open
                            // the mapping is unknowable — new block.
                            (Some(_), None) if self.distinct_tool_blocks() == 1 => self.last_tool,
                            // A new call.
                            _ => None,
                        };
                    }
                    let (index, is_new) = match block {
                        Some(i) => (i, false),
                        None => (self.fresh_index(), true),
                    };
                    // Register every key this fragment answered by, so later
                    // continuations — under either key — hit the same block.
                    if let Some(k) = &index_key {
                        self.tool_index.entry(k.clone()).or_insert(index);
                    }
                    if let Some(id) = id {
                        self.tool_index.entry(id.to_string()).or_insert(index);
                    }
                    self.last_tool = Some(index);
                    if is_new {
                        out.push(NormalisedEvent::BlockStart {
                            index,
                            kind: InboundKind::ToolUse,
                            tool: Some(ToolHeader {
                                id: id.unwrap_or("").to_string(),
                                name: call
                                    .pointer("/function/name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            }),
                        });
                    }
                    if let Some(args) = call
                        .pointer("/function/arguments")
                        .and_then(Value::as_str)
                        .filter(|a| !a.is_empty())
                    {
                        out.push(NormalisedEvent::BlockDelta {
                            index,
                            text: Some(args.to_string()),
                            signature: None,
                        });
                    }
                }
            }
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                out.push(NormalisedEvent::Stop {
                    reason: reason.to_string(),
                });
            }
            break;
        }
        if let Some(usage) = data.get("usage") {
            let input = usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            out.push(NormalisedEvent::Usage {
                usage: UsageWire {
                    top_input_tokens: input,
                    top_output_tokens: output,
                    iterations: vec![IterationUsage {
                        input_tokens: input,
                        output_tokens: output,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                    }],
                    billing_input_tokens: input,
                    billing_output_tokens: output,
                    context_input_tokens: input,
                },
            });
        }
        out
    }
}
