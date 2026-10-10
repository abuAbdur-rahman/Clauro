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

/// Tasks/005's recorded Gemini wire, fixture-first (§6): thought deltas are
/// marked per-delta by `extra_content.google.thought`, the `<thought>` /
/// `</thought>` markup rides `delta.content`, and the closing chunk carries
/// the close tag **and the first answer characters in one delta**. Ignoring
/// the marker (or splitting on tags alone) renders reasoning as answer —
/// the plausible-looking wrong transcript D80 exists to prevent.
///
/// The fixture is synthesised from the shape recorded live in `Tasks/005`
/// (endpoint, envelope, marker name, shared closing delta); no key was used.
#[test]
fn gemini_thought_marker_routes_reasoning_to_thinking_not_answer() {
    let events = run(4096, &fixture("openai_thought_marker.sse"));

    // 1. The markup itself never reaches either block.
    for event in &events {
        if let NormalisedEvent::BlockDelta { text: Some(t), .. } = event {
            assert!(
                !t.contains("<thought") && !t.contains("</thought>"),
                "markers are stripped before the transcript sees them: {events:?}"
            );
        }
    }

    // 2. Exactly two regions, thinking first: the thought streams into one
    //    thinking block, the answer into one text block, never one shared.
    let starts: Vec<(u32, InboundKind)> = events
        .iter()
        .filter_map(|e| match e {
            NormalisedEvent::BlockStart { index, kind, .. } => Some((*index, *kind)),
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 2, "one start per region: {events:?}");
    assert_eq!(starts[0].1, InboundKind::Thinking, "{events:?}");
    assert_eq!(starts[1].1, InboundKind::Text, "{events:?}");
    let thinking_index = starts[0].0;
    let text_index = starts[1].0;
    assert_ne!(thinking_index, text_index);

    // 3. The shared closing delta split correctly: the thought parts are the
    //    thinking block's deltas, "The answer is 4." opens the text block.
    let deltas_of = |index: u32| -> Vec<&str> {
        events
            .iter()
            .filter_map(|e| match e {
                NormalisedEvent::BlockDelta {
                    index: i,
                    text: Some(t),
                    ..
                } if *i == index => Some(t.as_str()),
                _ => None,
            })
            .collect()
    };
    assert_eq!(
        deltas_of(thinking_index),
        vec!["2 + 2 is arithmetic.", " The sum is 4."],
        "thought deltas, markers stripped: {events:?}"
    );
    assert_eq!(
        deltas_of(text_index),
        vec!["The answer is 4.", " Exactly."],
        "answer text only, starting after the close tag: {events:?}"
    );
}

/// The shared closing delta may arrive without the marker (005 records the
/// shape of the content, not the marking of every server variant): an open
/// thought still closes on `</thought>`, and the tail is answer text.
#[test]
fn a_closing_delta_without_the_marker_still_splits_thought_from_answer() {
    let events = feed_chunks(&[
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"<thought>hmm\",\"extra_content\":{\"google\":{\"thought\":true}}},\"finish_reason\":null}]}\n\n",
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"</thought>4\"},\"finish_reason\":null}]}\n\n",
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"!\"},\"finish_reason\":null}]}\n\n",
    ]);
    let starts: Vec<(u32, InboundKind)> = events
        .iter()
        .filter_map(|e| match e {
            NormalisedEvent::BlockStart { index, kind, .. } => Some((*index, *kind)),
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 2, "one start per region: {events:?}");
    let thinking_index = starts[0].0;
    assert_eq!(starts[0].1, InboundKind::Thinking, "{events:?}");
    let deltas_of = |index: u32| -> Vec<&str> {
        events
            .iter()
            .filter_map(|e| match e {
                NormalisedEvent::BlockDelta {
                    index: i,
                    text: Some(t),
                    ..
                } if *i == index => Some(t.as_str()),
                _ => None,
            })
            .collect()
    };
    assert_eq!(deltas_of(thinking_index), vec!["hmm"], "{events:?}");
    let all: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            NormalisedEvent::BlockDelta { text: Some(t), .. } => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        all.contains(&"4!") || all == vec!["hmm", "4", "!"],
        "answer tail arrives as text, never markup: {events:?}"
    );
}

/// One delta can open and close the thought in a single frame — the shared
/// delta shape collapses to thought-part then answer-part in one pass.
#[test]
fn a_single_delta_opening_and_closing_the_thought_splits_both_ways() {
    let events = feed_chunks(&[
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"<thought>thinking</thought>answer\",\"extra_content\":{\"google\":{\"thought\":true}}},\"finish_reason\":null}]}\n\n",
    ]);
    let deltas: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            NormalisedEvent::BlockDelta { text: Some(t), .. } => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        deltas,
        vec!["thinking", "answer"],
        "thought part then answer part: {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, NormalisedEvent::Ignored { .. })),
        "recognised markers are not an unknown shape: {events:?}"
    );
}
