//! CodeRabbit PR #3 findings (Major): synthesised indices must be unique,
//! and the line buffer must be bounded (RED).
//!
//! - Mixed streams (reasoning + content + tool) produced colliding index 0
//!   starts; index-keyed consumers would merge thinking into the answer.
//! - An unterminated line grew the buffer without limit, and invalid bytes
//!   stalled the decoder instead of emitting replacement characters.

use clauro_transport::{InboundKind, NormalisedEvent, OpenAiParser, SseFramer, StreamParser};

fn feed(parser: &mut OpenAiParser, framer: &mut SseFramer, chunk: &str) -> Vec<NormalisedEvent> {
    let mut out = Vec::new();
    for raw in framer
        .feed(chunk.as_bytes())
        .expect("inline chunks are small valid UTF-8")
    {
        out.extend(parser.feed(&raw));
    }
    out
}

#[test]
fn mixed_stream_starts_carry_distinct_indices() {
    let mut parser = OpenAiParser::new();
    let mut framer = SseFramer::new();
    let mut events = Vec::new();
    events.extend(feed(
        &mut parser,
        &mut framer,
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"why\"},\"finish_reason\":null}]}\n\n",
    ));
    events.extend(feed(
        &mut parser,
        &mut framer,
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"},\"finish_reason\":null}]}\n\n",
    ));
    events.extend(feed(
        &mut parser,
        &mut framer,
        "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"fs\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
    ));
    let mut starts: Vec<(InboundKind, u32)> = events
        .iter()
        .filter_map(|e| match e {
            NormalisedEvent::BlockStart { kind, index, .. } => Some((*kind, *index)),
            _ => None,
        })
        .collect();
    starts.sort_by_key(|(_, index)| *index);
    let kinds: Vec<InboundKind> = starts.iter().map(|(kind, _)| *kind).collect();
    let mut indices: Vec<u32> = starts.iter().map(|(_, index)| *index).collect();
    indices.sort();
    indices.dedup();
    assert_eq!(starts.len(), 3, "three blocks started: {events:?}");
    assert_eq!(indices.len(), 3, "three distinct indices: {events:?}");
    assert!(kinds.contains(&InboundKind::Thinking));
    assert!(kinds.contains(&InboundKind::Text));
    assert!(kinds.contains(&InboundKind::ToolUse));
}

#[test]
fn oversized_line_fails_instead_of_growing_forever() {
    let mut framer = SseFramer::new();
    let big = vec![b'x'; 2 * 1024 * 1024];
    assert!(
        framer.feed(&big).is_err(),
        "a 2 MiB unterminated line must fail, not buffer"
    );
}

#[test]
fn invalid_bytes_become_replacement_chars_not_a_stall() {
    let mut framer = SseFramer::new();
    // 0xFF is never valid UTF-8; 0xE2 0x82 is a split codepoint tail.
    let events = framer
        .feed(b"data: a\xff\xe2\x82\n\ndata: ok\n\n")
        .expect("invalid bytes must not fail the stream");
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(events[0].data.contains('\u{FFFD}'), "{events:?}");
    assert_eq!(events[1].data, "ok");
}

#[test]
fn split_codepoint_waits_for_its_tail() {
    let mut framer = SseFramer::new();
    let first = framer
        .feed(b"data: h\xc3")
        .expect("incomplete tail must not fail");
    assert!(first.is_empty(), "incomplete codepoint waits: {first:?}");
    let done = framer.feed(b"\xa9\n\n").expect("tail completes");
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].data, "h\u{e9}");
}
