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

/// Audit 12/finding 2 — the *cumulative* event buffer is bounded, not just
/// one line (RED). A hostile compat endpoint streams `data: x\n` forever;
/// each line is tiny, so the line cap never fires and `pending_data` grows
/// without limit. The cap must hold at the boundary and fail just past it.
#[test]
fn pending_event_bytes_are_capped_with_a_typed_error() {
    use clauro_transport::sse::{FramerError, MAX_EVENT_BYTES};

    let mut framer = SseFramer::new();
    let line = format!("data: {}\n", "a".repeat(1024));
    // Exactly MAX_EVENT_BYTES of pending data, one line per feed (the live
    // shape): the boundary must be accepted.
    for _ in 0..MAX_EVENT_BYTES / 1024 {
        framer
            .feed(line.as_bytes())
            .expect("exactly at the cap is not an overflow");
    }
    // One more line crosses the cap: typed error, not unbounded growth.
    let err = framer
        .feed(line.as_bytes())
        .expect_err("one line past the cap must fail, not buffer");
    assert!(
        matches!(err, FramerError::EventTooLong(n) if n == MAX_EVENT_BYTES + 1024),
        "typed overflow naming the cumulative size: {err:?}"
    );
}

/// Audit 12/finding 5, framer half — a non-newline-terminated tail line is
/// discarded at EOF, never dispatched as a complete event (RED). The SSE
/// spec discards it; dispatching it makes a truncated stream look whole.
#[test]
fn unterminated_tail_line_is_discarded_at_eof() {
    let mut framer = SseFramer::new();
    let events = framer
        .feed(b"data: {\"type\":\"message_stop\"}")
        .expect("inline feed is small valid UTF-8");
    assert!(events.is_empty(), "line not complete yet: {events:?}");
    let tail = framer.finish();
    assert!(
        tail.is_empty(),
        "an unterminated tail is discarded at EOF, not dispatched: {tail:?}"
    );
}

/// Audit 12/finding 10 — a bare `data` field is an empty value, not a drop
/// (RED). Per the SSE spec it appends an empty line to the data buffer.
#[test]
fn bare_data_field_is_an_empty_value_not_a_drop() {
    let mut framer = SseFramer::new();
    let events = framer
        .feed(b"data\ndata: x\n\n")
        .expect("inline feed is small valid UTF-8");
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
        events[0].data, "\nx",
        "bare field = empty value: {events:?}"
    );
}

/// Audit 12/finding 10 — an event with a type but no data is discarded, per
/// spec (RED). Dispatching it hands the parser an empty-data event the wire
/// never sent.
#[test]
fn type_only_event_is_discarded_per_spec() {
    let mut framer = SseFramer::new();
    let events = framer
        .feed(b"event: frobnicate\n\n")
        .expect("inline feed is small valid UTF-8");
    assert!(
        events.is_empty(),
        "type-only events are discarded, not dispatched: {events:?}"
    );
}

/// Audit 12/finding 10 — a lone `\r` terminates a line, eagerly, including
/// when split across feeds (RED). Per spec the CR ends the line at once; a
/// following LF — here or in the next feed — is the second half of a CRLF
/// pair and is dropped, never a second terminator.
#[test]
fn lone_carriage_return_terminates_a_line() {
    let mut framer = SseFramer::new();
    let events = framer
        .feed(b"data: x\r\r")
        .expect("inline feed is small valid UTF-8");
    assert_eq!(
        events.len(),
        1,
        "lone \\r is a line terminator, and a blank \\r dispatches: {events:?}"
    );
    assert_eq!(events[0].data, "x");

    // Split across feeds: the line ends at the CR, the event dispatches on
    // the blank CR in the next feed.
    let mut framer = SseFramer::new();
    assert!(
        framer
            .feed(b"data: a\r")
            .expect("inline feed is small valid UTF-8")
            .is_empty(),
        "line terminated, event not yet dispatched"
    );
    let events = framer
        .feed(b"\r")
        .expect("inline feed is small valid UTF-8");
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].data, "a");

    // CRLF split across feeds is ONE terminator, not two.
    let mut framer = SseFramer::new();
    assert!(
        framer
            .feed(b"event: x\r")
            .expect("inline feed is small valid UTF-8")
            .is_empty(),
        "line terminated, event not yet dispatched"
    );
    let events = framer
        .feed(b"\ndata: y\r\r")
        .expect("inline feed is small valid UTF-8");
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].event_type, "x");
    assert_eq!(events[0].data, "y");
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
