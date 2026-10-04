//! The Anthropic adapter: provider events become `NormalisedEvent`s.
//!
//! The four parser rules (`CONTRACTS.md` §5) live here:
//! - **P1** unrecognised events are `Ignored`, never fatal (D80).
//! - **P2** `signature_delta` is captured even when the block renders empty
//!   (`thinking.display: "omitted"`, D72, D73).
//! - **P3** `input_transformations` is read on `message_start` **and** the
//!   final `message_delta` — the only runtime signal of a drop (D71).
//! - **P4** usage comes from `usage.iterations`: sum every iteration for
//!   billing, take the last for context size, never read top-level fields for
//!   either purpose once iterations exist (D70).
//!
//! Fixture shapes are synthetic (`TECH_STACK.md` §4): they pin *our* parser
//! contract, not Anthropic's wire, which may grow new events at any time.

use crate::sse::RawSseEvent;
use serde_json::Value;

/// Block kinds the stream can open. The transcript never branches on
/// provider: OpenAI reasoning maps to `Thinking` on the other adapter (D54).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboundKind {
    Text,
    Thinking,
    ToolUse,
    /// Server-side compaction checkpoint (D69). Parsed here, acted on in 017.
    Compaction,
}

/// Tool header carried on `BlockStart` so the transcript can pair every
/// `tool_use` with its result (I1, D61).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolHeader {
    pub id: String,
    pub name: String,
}

/// One entry of `usage.iterations` (D70).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IterationUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

/// Usage with both channels kept visible: the top-level fields (what a naive
/// footer would read) and the computed billing/context figures (what it must
/// read). Keeping `top_*` on the struct is what makes a 0/0 regression
/// testable rather than silent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageWire {
    pub top_input_tokens: u64,
    pub top_output_tokens: u64,
    pub iterations: Vec<IterationUsage>,
    pub billing_input_tokens: u64,
    pub billing_output_tokens: u64,
    pub context_input_tokens: u64,
}

/// One normalised provider event (`CONTRACTS.md` §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalisedEvent {
    BlockStart {
        index: u32,
        kind: InboundKind,
        tool: Option<ToolHeader>,
    },
    BlockDelta {
        index: u32,
        text: Option<String>,
        signature: Option<String>,
    },
    BlockStop {
        index: u32,
    },
    Usage {
        usage: UsageWire,
    },
    InputTransformed {
        dropped: u64,
    },
    Stop {
        reason: String,
    },
    Ping,
    Error {
        message: String,
    },
    /// Fail open on the stream (D80). The transcript layer decides whether an
    /// ignored event deserves a visible notice.
    Ignored {
        raw_type: String,
    },
}

/// Feed raw events, take normalised ones. Anthropic sends explicit
/// start/stop markers, so this parser is stateless; the OpenAI-compatible
/// one synthesises starts and holds state behind the same trait.
pub trait StreamParser {
    fn feed(&mut self, event: &RawSseEvent) -> Vec<NormalisedEvent>;
}

/// The Anthropic adapter's streaming half.
pub struct AnthropicParser;

impl AnthropicParser {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    fn ignored(event_type: &str) -> Vec<NormalisedEvent> {
        vec![NormalisedEvent::Ignored {
            raw_type: event_type.to_string(),
        }]
    }
}

impl Default for AnthropicParser {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamParser for AnthropicParser {
    fn feed(&mut self, event: &RawSseEvent) -> Vec<NormalisedEvent> {
        let data: Value = match serde_json::from_str(&event.data) {
            Ok(v) => v,
            Err(_) => return Self::ignored("unparseable"),
        };
        match event.event_type.as_str() {
            "message_start" => data
                .pointer("/message/input_transformations")
                .and_then(parse_dropped)
                .map(|dropped| NormalisedEvent::InputTransformed { dropped })
                .into_iter()
                .collect(),
            "content_block_start" => block_start(&data),
            "content_block_delta" => block_delta(&data),
            "content_block_stop" => data
                .get("index")
                .and_then(Value::as_u64)
                .map(|index| NormalisedEvent::BlockStop {
                    index: index as u32,
                })
                .into_iter()
                .collect(),
            "message_delta" => message_delta(&data),
            "message_stop" => Vec::new(),
            "ping" => vec![NormalisedEvent::Ping],
            "error" => vec![NormalisedEvent::Error {
                message: data
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .or_else(|| data.get("message").and_then(Value::as_str))
                    .unwrap_or("provider error")
                    .to_string(),
            }],
            other => Self::ignored(other),
        }
    }
}

fn block_start(data: &Value) -> Vec<NormalisedEvent> {
    let (Some(index), Some(block)) = (
        data.get("index").and_then(Value::as_u64),
        data.get("content_block"),
    ) else {
        return vec![NormalisedEvent::Ignored {
            raw_type: "content_block_start".to_string(),
        }];
    };
    let kind = match block.get("type").and_then(Value::as_str) {
        Some("text") => InboundKind::Text,
        Some("thinking") | Some("redacted_thinking") => InboundKind::Thinking,
        Some("tool_use") => InboundKind::ToolUse,
        Some("compaction") => InboundKind::Compaction,
        _ => {
            return vec![NormalisedEvent::Ignored {
                raw_type: "unknown-block".to_string(),
            }];
        }
    };
    let tool = (kind == InboundKind::ToolUse).then(|| ToolHeader {
        id: block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        name: block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    });
    vec![NormalisedEvent::BlockStart {
        index: index as u32,
        kind,
        tool,
    }]
}

fn block_delta(data: &Value) -> Vec<NormalisedEvent> {
    let (Some(index), Some(delta)) = (data.get("index").and_then(Value::as_u64), data.get("delta"))
    else {
        return vec![NormalisedEvent::Ignored {
            raw_type: "content_block_delta".to_string(),
        }];
    };
    let event = match delta.get("type").and_then(Value::as_str) {
        Some("text_delta") => NormalisedEvent::BlockDelta {
            index: index as u32,
            text: delta
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string),
            signature: None,
        },
        // P2: one EMPTY thinking_delta, then signature_delta — both kept.
        Some("thinking_delta") => NormalisedEvent::BlockDelta {
            index: index as u32,
            text: delta
                .get("thinking")
                .and_then(Value::as_str)
                .map(str::to_string),
            signature: None,
        },
        Some("signature_delta") => NormalisedEvent::BlockDelta {
            index: index as u32,
            text: None,
            signature: delta
                .get("signature")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        Some("input_json_delta") => NormalisedEvent::BlockDelta {
            index: index as u32,
            text: delta
                .get("partial_json")
                .and_then(Value::as_str)
                .map(str::to_string),
            signature: None,
        },
        _ => {
            return vec![NormalisedEvent::Ignored {
                raw_type: "unknown-delta".to_string(),
            }];
        }
    };
    vec![event]
}

fn message_delta(data: &Value) -> Vec<NormalisedEvent> {
    let mut out = Vec::new();
    if let Some(dropped) = data
        .pointer("/delta/input_transformations")
        .and_then(parse_dropped)
    {
        out.push(NormalisedEvent::InputTransformed { dropped });
    }
    if let Some(usage) = data.get("usage") {
        out.push(NormalisedEvent::Usage {
            usage: usage_wire(usage),
        });
    }
    if let Some(reason) = data.pointer("/delta/stop_reason").and_then(Value::as_str) {
        out.push(NormalisedEvent::Stop {
            reason: reason.to_string(),
        });
    }
    out
}

/// P4. Iterations present → sum for billing, last for context, top-level
/// unread. Iterations absent (an ordinary turn) → top-level fields are the
/// only source and are used directly.
fn usage_wire(usage: &Value) -> UsageWire {
    let top_input_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let top_output_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let iterations: Vec<IterationUsage> = usage
        .get("iterations")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|it| IterationUsage {
                    input_tokens: it.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
                    output_tokens: it.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
                    cache_read_tokens: it
                        .get("cache_read_input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    cache_write_tokens: it
                        .get("cache_creation_input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    if iterations.is_empty() {
        UsageWire {
            top_input_tokens,
            top_output_tokens,
            iterations,
            billing_input_tokens: top_input_tokens,
            billing_output_tokens: top_output_tokens,
            context_input_tokens: top_input_tokens,
        }
    } else {
        UsageWire {
            top_input_tokens,
            top_output_tokens,
            billing_input_tokens: iterations.iter().map(|i| i.input_tokens).sum(),
            billing_output_tokens: iterations.iter().map(|i| i.output_tokens).sum(),
            context_input_tokens: iterations.last().map(|i| i.input_tokens).unwrap_or(0),
            iterations,
        }
    }
}

/// P3. Accepts the array form (`[{dropped_thinking_blocks: n}]`, as sent) and
/// the bare-object form, so a wire-shape revision degrades to a count rather
/// than a missed signal.
fn parse_dropped(value: &Value) -> Option<u64> {
    if let Some(arr) = value.as_array() {
        let total: u64 = arr
            .iter()
            .filter_map(|e| e.get("dropped_thinking_blocks").and_then(Value::as_u64))
            .sum();
        return Some(total);
    }
    value.get("dropped_thinking_blocks").and_then(Value::as_u64)
}
