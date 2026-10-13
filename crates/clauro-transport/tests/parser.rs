//! Task 005 — Anthropic SSE parsing, rules P1–P4 (RED).
//!
//! Feeds the synthetic fixtures through the framer + adapter and asserts the
//! four rules `CONTRACTS.md` §5 pins: unknown events never fatal (P1),
//! `signature_delta` captured on empty thinking (P2), `input_transformations`
//! read on both `message_start` and the final delta (P3), usage from
//! `usage.iterations` with top-level fields ignored (P4).

use clauro_transport::{AnthropicParser, InboundKind, NormalisedEvent, SseFramer, StreamParser};

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(path).expect("fixture must read")
}

/// Framer fed in `chunk`-byte slices (reassembly proof), adapter drained per
/// raw event, remainder flushed at the end.
fn run(chunk: usize, bytes: &[u8]) -> Vec<NormalisedEvent> {
    let mut framer = SseFramer::new();
    let mut parser = AnthropicParser::new();
    let mut out = Vec::new();
    for slice in bytes.chunks(chunk) {
        for raw in framer.feed(slice).expect("fixtures are small valid UTF-8") {
            out.extend(parser.feed(&raw));
        }
    }
    for raw in framer.finish() {
        out.extend(parser.feed(&raw));
    }
    out
}

fn texts(events: &[NormalisedEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            NormalisedEvent::BlockDelta { text: Some(t), .. } => Some(t.clone()),
            _ => None,
        })
        .collect()
}

// ── P2: omitted thinking ─────────────────────────────────────────────────────

#[test]
fn omitted_thinking_yields_signature_with_empty_delta() {
    let events = run(4096, &fixture("omitted_thinking.sse"));
    let kinds: Vec<String> = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                NormalisedEvent::BlockStart { .. }
                    | NormalisedEvent::BlockDelta { .. }
                    | NormalisedEvent::BlockStop { .. }
            )
        })
        .map(|e| match e {
            NormalisedEvent::BlockStart { index, kind, .. } => {
                format!("start:{index}:{kind:?}")
            }
            NormalisedEvent::BlockDelta {
                index,
                text,
                signature,
            } => format!("delta:{index}:{text:?}:{signature:?}"),
            NormalisedEvent::BlockStop { index } => format!("stop:{index}"),
            _ => unreachable!(),
        })
        .collect();
    assert!(kinds.contains(&"start:0:Thinking".to_string()), "{kinds:?}");
    assert!(
        kinds.contains(&"delta:0:Some(\"\"):None".to_string()),
        "exactly one EMPTY thinking_delta (D73): {kinds:?}"
    );
    assert!(
        kinds.contains(&"delta:0:None:Some(\"sig-abc\")".to_string()),
        "signature captured even though the block renders empty (D72): {kinds:?}"
    );
    assert!(kinds.contains(&"stop:0".to_string()), "{kinds:?}");
    assert!(texts(&events).contains(&"Hi".to_string()));
}

// ── framing: splits reassemble, UTF-8 splits included ────────────────────────

#[test]
fn chunk_splits_reassemble_identically() {
    let bytes = fixture("omitted_thinking.sse");
    let whole = run(4096, &bytes);
    for chunk in [1, 2, 3, 5, 7, 13] {
        assert_eq!(
            run(chunk, &bytes),
            whole,
            "chunk size {chunk} must reassemble"
        );
    }
}

#[test]
fn multibyte_text_survives_byte_splits() {
    // "héllo" is split mid-codepoint at 3-byte slices; the framer must buffer
    // the incomplete tail, not emit replacement characters.
    let events = run(3, &fixture("unknown_event.sse"));
    assert!(
        texts(&events).contains(&"héllo, still here".to_string()),
        "{events:?}"
    );
}

// ── P4: compaction usage ─────────────────────────────────────────────────────

#[test]
fn compaction_usage_comes_from_iterations_not_top_level() {
    let events = run(7, &fixture("compaction_response.sse"));
    let usage = events.iter().find_map(|e| match e {
        NormalisedEvent::Usage { usage } => Some(usage),
        _ => None,
    });
    let usage = usage.expect("compaction response must carry a usage event");
    assert_eq!(
        usage.billing_input_tokens, 5300,
        "sum every iteration for billing (D70)"
    );
    assert_eq!(usage.billing_output_tokens, 250);
    assert_eq!(
        usage.context_input_tokens, 300,
        "take the LAST iteration for context size (D70)"
    );
    assert_eq!(usage.iterations.len(), 2);
}

// ── Audit 12/finding 7 — the compaction path asserts its interesting property ──

/// `InboundKind::Compaction` must be recognised at its block start; every
/// other fixture asserts its interesting property, this one now does too.
#[test]
fn compaction_block_start_is_recognised() {
    let events = run(4096, &fixture("compaction_response.sse"));
    assert!(
        events.contains(&NormalisedEvent::BlockStart {
            index: 0,
            kind: InboundKind::Compaction,
            tool: None,
        }),
        "BlockStart{{kind:Compaction,index:0}} must surface: {events:?}"
    );
}

// ── Audit 12/finding 8 — an oversize wire index never aliases block 0 ────────

/// A wire index ≥ 2³² truncated (`as u32`) to 0 and hijacked the first
/// block. Oversize is nonsense from a provider: `Ignored`, never an alias.
#[test]
fn oversize_wire_index_never_aliases_block_zero() {
    let mut parser = AnthropicParser::new();
    let mut framer = SseFramer::new();
    for raw in framer
        .feed(
            b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":4294967296,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
              event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":4294967296,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n\
              event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":4294967296}\n\n",
        )
        .expect("inline feed is small valid UTF-8")
    {
        for event in parser.feed(&raw) {
            assert!(
                !matches!(
                    &event,
                    NormalisedEvent::BlockStart { index: 0, .. }
                        | NormalisedEvent::BlockDelta { index: 0, .. }
                        | NormalisedEvent::BlockStop { index: 0 }
                ),
                "2^32 must not alias block 0: {event:?}"
            );
            assert!(
                matches!(event, NormalisedEvent::Ignored { .. }),
                "oversize index degrades to Ignored, never fatal: {event:?}"
            );
        }
    }
}

// ── Audit 12/finding 9 — untrusted sums saturate, never overflow ─────────────

#[test]
fn untrusted_sums_saturate_instead_of_overflowing() {
    let mut parser = AnthropicParser::new();
    let mut framer = SseFramer::new();
    for raw in framer
        .feed(
            b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"x\",\"content\":[],\"input_transformations\":[{\"dropped_thinking_blocks\":18446744073709551615},{\"dropped_thinking_blocks\":5}]}}\n\n\
              event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{},\"usage\":{\"iterations\":[{\"input_tokens\":18446744073709551615,\"output_tokens\":18446744073709551615},{\"input_tokens\":1,\"output_tokens\":1}]}}\n\n",
        )
        .expect("inline feed is small valid UTF-8")
    {
        for event in parser.feed(&raw) {
            match event {
                NormalisedEvent::InputTransformed { dropped } => {
                    assert_eq!(
                        dropped,
                        u64::MAX,
                        "hostile counts saturate, never panic"
                    );
                }
                NormalisedEvent::Usage { usage } => {
                    assert_eq!(usage.billing_input_tokens, u64::MAX);
                    assert_eq!(usage.billing_output_tokens, u64::MAX);
                }
                _ => {}
            }
        }
    }
}

// ── P3: dropped thinking ─────────────────────────────────────────────────────

#[test]
fn input_transformations_read_on_start_and_final_delta() {
    let events = run(11, &fixture("dropped_block.sse"));
    let dropped: Vec<u64> = events
        .iter()
        .filter_map(|e| match e {
            NormalisedEvent::InputTransformed { dropped } => Some(*dropped),
            _ => None,
        })
        .collect();
    assert_eq!(
        dropped,
        vec![2, 2],
        "one signal on message_start, one on the final delta (D71): {events:?}"
    );
}

// ── P1: unknown events ────────────────────────────────────────────────────────

#[test]
fn unknown_event_is_ignored_and_stream_continues() {
    let events = run(9, &fixture("unknown_event.sse"));
    assert!(
        events.contains(&NormalisedEvent::Ignored {
            raw_type: "frobnicate".to_string()
        }),
        "unrecognised event yields ignored, never fatal (D80): {events:?}"
    );
    assert!(
        events.contains(&NormalisedEvent::Ping),
        "ping is a keepalive"
    );
    assert!(
        texts(&events).contains(&"héllo, still here".to_string()),
        "parsing continues after the unknown event: {events:?}"
    );
}

#[test]
fn ping_keeps_alive_error_terminates_with_typed_error() {
    let mut parser = AnthropicParser::new();
    let mut framer = SseFramer::new();
    let raw = framer
        .feed(b"event: ping\ndata: {\"type\":\"ping\"}\n\n")
        .expect("inline feed is small valid UTF-8");
    assert_eq!(raw.len(), 1);
    assert_eq!(parser.feed(&raw[0]), vec![NormalisedEvent::Ping]);

    let raw = framer
        .feed(
            b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n",
        )
        .expect("inline feed is small valid UTF-8");
    assert_eq!(raw.len(), 1);
    assert!(
        matches!(
            &parser.feed(&raw[0])[..],
            [NormalisedEvent::Error { message }] if message.contains("Overloaded")
        ),
        "error terminates with a typed error"
    );
}

#[test]
fn malformed_data_line_is_ignored_not_fatal() {
    // One bad line must not kill a good turn; transcript invariants (006)
    // catch corruption, the stream stays open (P1 reasoning).
    let mut parser = AnthropicParser::new();
    let mut framer = SseFramer::new();
    let raws = framer
        .feed(b"event: content_block_delta\ndata: {not json}\n\n")
        .expect("inline feed is small valid UTF-8");
    assert_eq!(raws.len(), 1);
    let out = parser.feed(&raws[0]);
    assert!(
        matches!(&out[..], [NormalisedEvent::Ignored { .. }]),
        "malformed data yields ignored: {out:?}"
    );
}

#[test]
fn message_stop_emits_nothing() {
    let mut parser = AnthropicParser::new();
    let mut framer = SseFramer::new();
    let raws = framer
        .feed(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
        .expect("inline feed is small valid UTF-8");
    assert_eq!(raws.len(), 1);
    assert!(
        parser.feed(&raws[0]).is_empty(),
        "stream end is the termination signal, not another event"
    );
}

#[test]
fn tool_use_start_carries_id_and_name_for_pairing() {
    let mut parser = AnthropicParser::new();
    let mut framer = SseFramer::new();
    let raws = framer
        .feed(
            b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_9\",\"name\":\"fs\",\"input\":{}}}\n\n",
        )
        .expect("inline feed is small valid UTF-8");
    let out = parser.feed(&raws[0]);
    assert!(
        matches!(
            &out[..],
            [NormalisedEvent::BlockStart {
                kind: InboundKind::ToolUse,
                tool: Some(t),
                ..
            }] if t.id == "call_9" && t.name == "fs"
        ),
        "I1 pairing needs id+name on the start event: {out:?}"
    );
}
