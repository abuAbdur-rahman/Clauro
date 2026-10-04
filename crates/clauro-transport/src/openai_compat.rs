//! The OpenAI-compatible adapter: third-party chunks, same union.
//!
//! Everything else funnels through this adapter (D48), and the dialect varies
//! across providers in streaming deltas, tool-call framing, and
//! reasoning-token fields. Two consequences:
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
    text_started: bool,
    thinking_started: bool,
    tool_index: BTreeMap<String, u32>,
    tool_seq: u32,
}

impl OpenAiParser {
    #[must_use]
    pub fn new() -> Self {
        Self {
            text_started: false,
            thinking_started: false,
            tool_index: BTreeMap::new(),
            tool_seq: 0,
        }
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
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if !self.text_started {
                    self.text_started = true;
                    out.push(NormalisedEvent::BlockStart {
                        index: 0,
                        kind: InboundKind::Text,
                        tool: None,
                    });
                }
                out.push(NormalisedEvent::BlockDelta {
                    index: 0,
                    text: Some(text.to_string()),
                    signature: None,
                });
            }
            if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
                if !self.thinking_started {
                    self.thinking_started = true;
                    out.push(NormalisedEvent::BlockStart {
                        index: 0,
                        kind: InboundKind::Thinking,
                        tool: None,
                    });
                }
                out.push(NormalisedEvent::BlockDelta {
                    index: 0,
                    text: Some(reasoning.to_string()),
                    signature: None,
                });
            }
            if let Some(refusal) = delta.get("refusal").and_then(Value::as_str) {
                // A refusal is shown, not dropped: silence would read as a stall.
                if !self.text_started {
                    self.text_started = true;
                    out.push(NormalisedEvent::BlockStart {
                        index: 0,
                        kind: InboundKind::Text,
                        tool: None,
                    });
                }
                out.push(NormalisedEvent::BlockDelta {
                    index: 0,
                    text: Some(refusal.to_string()),
                    signature: None,
                });
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    // Keyed by stream index first: the opening chunk carries
                    // both id and index, continuations carry index only.
                    let key = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|i| format!("index:{i}"))
                        .or_else(|| call.get("id").and_then(Value::as_str).map(str::to_string))
                        .unwrap_or_else(|| "unknown-call".to_string());
                    let is_new = !self.tool_index.contains_key(&key);
                    let index = if let Some(&i) = self.tool_index.get(&key) {
                        i
                    } else {
                        let i = self.tool_seq;
                        self.tool_seq += 1;
                        self.tool_index.insert(key, i);
                        i
                    };
                    if is_new {
                        out.push(NormalisedEvent::BlockStart {
                            index,
                            kind: InboundKind::ToolUse,
                            tool: Some(ToolHeader {
                                id: call
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
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
