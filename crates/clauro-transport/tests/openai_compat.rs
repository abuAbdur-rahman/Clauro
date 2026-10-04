//! Task 005 — the OpenAI-compatible adapter (RED).
//!
//! Same `NormalisedEvent` union as Anthropic: the transcript never branches on
//! provider (D48, D54). Third-party servers vary in streaming deltas,
//! tool-call framing, and reasoning fields, so anything unrecognised degrades
//! **visibly** — an `Ignored` the transcript layer (006) renders as a notice,
//! never a plausible-looking wrong turn.

use clauro_transport::{InboundKind, NormalisedEvent, OpenAiParser, SseFramer, StreamParser};

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(path).expect("fixture must read")
}

fn run(chunk: usize, bytes: &[u8]) -> Vec<NormalisedEvent> {
    let mut framer = SseFramer::new();
    let mut parser = OpenAiParser::new();
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

#[test]
fn unknown_object_is_ignored_and_stream_continues() {
    let events = run(13, &fixture("openai_unknown.sse"));
    assert!(
        events.contains(&NormalisedEvent::Ignored {
            raw_type: "chat.completion.frobnicate".to_string()
        }),
        "unrecognised object yields ignored: {events:?}"
    );
    let joined = texts(&events).concat();
    assert_eq!(
        joined, "Hello",
        "content each side of the unknown chunk: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, NormalisedEvent::Stop { reason } if reason == "stop")),
        "finish_reason maps to stop: {events:?}"
    );
}

#[test]
fn done_terminates_quietly() {
    // `[DONE]` is framing, not an event: no output, stream end terminates.
    let events = run(4096, &fixture("openai_unknown.sse"));
    assert!(
        !events.iter().any(|e| matches!(
            e,
            NormalisedEvent::Ignored { raw_type } if raw_type == "[DONE]"
        )),
        "{events:?}"
    );
}

#[test]
fn text_synthesises_exactly_one_start() {
    let events = run(4096, &fixture("openai_unknown.sse"));
    let starts: Vec<_> = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                NormalisedEvent::BlockStart {
                    kind: InboundKind::Text,
                    ..
                }
            )
        })
        .collect();
    assert_eq!(
        starts.len(),
        1,
        "one start per stream, not per chunk: {events:?}"
    );
}

fn feed_chunks(chunks: &[&str]) -> Vec<NormalisedEvent> {
    let mut parser = OpenAiParser::new();
    let mut framer = SseFramer::new();
    let mut out = Vec::new();
    for c in chunks {
        for raw in framer
            .feed(c.as_bytes())
            .expect("inline chunks are small valid UTF-8")
        {
            out.extend(parser.feed(&raw));
        }
    }
    for raw in framer.finish() {
        out.extend(parser.feed(&raw));
    }
    out
}

#[test]
fn reasoning_content_maps_to_thinking() {
    let events = feed_chunks(&[
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"because\"},\"finish_reason\":null}]}\n\n",
    ]);
    assert!(
        matches!(
            &events[..],
            [
                NormalisedEvent::BlockStart {
                    kind: InboundKind::Thinking,
                    ..
                },
                NormalisedEvent::BlockDelta { text: Some(_), .. },
            ]
        ),
        "reasoning tokens normalise to the same thinking shape (D54): {events:?}"
    );
}

#[test]
fn tool_call_framing_yields_start_then_input_deltas() {
    let events = feed_chunks(&[
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"fs\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"a\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
    ]);
    assert!(
        matches!(
            &events[..],
            [
                NormalisedEvent::BlockStart {
                    kind: InboundKind::ToolUse,
                    tool: Some(_),
                    ..
                },
                NormalisedEvent::BlockDelta { text: Some(_), .. },
            ]
        ),
        "id+name on start, argument fragments as deltas: {events:?}"
    );
    match &events[0] {
        NormalisedEvent::BlockStart { tool: Some(t), .. } => {
            assert_eq!(t.id, "call_1");
            assert_eq!(t.name, "fs");
        }
        other => panic!("wrong first event: {other:?}"),
    }
}
