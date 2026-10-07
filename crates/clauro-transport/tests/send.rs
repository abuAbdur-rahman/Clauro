//! Task 006 — the HTTP send loop (RED).
//!
//! `retry_delay` had no caller until now: there was no send loop anywhere in
//! the repo, so nothing could stream. This file pins the loop's contract
//! **without a socket and without a key** — the byte source is a trait, and
//! the tests supply fixture bytes through it.
//!
//! What is pinned:
//! - every `NormalisedEvent` reaches the sink, in order, as bytes arrive —
//!   the property that makes a turn render rather than appear at `end_turn`;
//! - the byte-level split is irrelevant: chunk size 1 and the whole fixture
//!   produce identical event sequences;
//! - a retryable status retries, honouring `retry_delay` (D56), and a
//!   non-retryable status fails immediately without a second attempt;
//! - attempts stop at `MAX_ATTEMPTS` — an unbounded retry is a hung turn.
//!
//! Nothing here needs a provider, a key, or the network.

use clauro_transport::retry::MAX_ATTEMPTS;
use clauro_transport::send::{Attempt, ByteSource, SendError, StepSink};
use clauro_transport::{AnthropicParser, NormalisedEvent, SseFramer};

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(path).expect("fixture must read")
}

/// A source that replays canned bytes in `chunk`-sized slices, or reports a
/// status with no body — the two shapes a real HTTP response has.
struct Replay {
    chunks: std::cell::RefCell<Option<std::vec::IntoIter<Vec<u8>>>>,
    status: u16,
    retry_after: Option<String>,
    calls: std::cell::Cell<usize>,
}

impl Replay {
    fn bytes(bytes: Vec<u8>, chunk: usize) -> Self {
        let chunks: Vec<Vec<u8>> = bytes.chunks(chunk.max(1)).map(<[u8]>::to_vec).collect();
        Self {
            chunks: std::cell::RefCell::new(Some(chunks.into_iter())),
            status: 200,
            retry_after: None,
            calls: std::cell::Cell::new(0),
        }
    }

    fn status(status: u16, retry_after: Option<&str>) -> Self {
        Self {
            chunks: std::cell::RefCell::new(None),
            status,
            retry_after: retry_after.map(str::to_string),
            calls: std::cell::Cell::new(0),
        }
    }
}

impl ByteSource for Replay {
    fn attempt(&mut self) -> Result<Attempt, SendError> {
        self.calls.set(self.calls.get() + 1);
        match self.chunks.borrow_mut().take() {
            Some(chunks) => Ok(Attempt {
                status: self.status,
                retry_after: self.retry_after.clone(),
                chunks,
            }),
            None => Err(SendError::Status {
                status: self.status,
                retry_after: self.retry_after.clone(),
            }),
        }
    }
}

/// Run the loop over `source`, collecting everything the sink saw.
fn drive(source: &mut dyn ByteSource) -> (Vec<NormalisedEvent>, Result<u32, SendError>) {
    let mut framer = SseFramer::new();
    let mut parser = AnthropicParser::new();
    let mut seen: Vec<NormalisedEvent> = Vec::new();
    let mut sink: StepSink = &mut |event| seen.push(event);
    let outcome =
        clauro_transport::send::stream_step(source, &mut framer, &mut parser, &mut sink, 0);
    (seen, outcome)
}

/// The whole point of the loop: events reach the sink while bytes are still
/// arriving, so a renderer can draw before the response completes.
#[test]
fn events_reach_the_sink_as_bytes_arrive() {
    let bytes = fixture("omitted_thinking.sse");
    let mut source = Replay::bytes(bytes, 64);
    let (seen, outcome) = drive(&mut source);

    assert!(outcome.is_ok(), "200 must succeed: {outcome:?}");
    assert!(
        seen.iter()
            .any(|e| matches!(e, NormalisedEvent::BlockStart { .. })),
        "a block start reached the sink: {seen:?}"
    );
    assert!(
        seen.iter()
            .any(|e| matches!(e, NormalisedEvent::BlockDelta { .. })),
        "a delta reached the sink: {seen:?}"
    );
}

/// Byte-boundary splitting must not change what the sink sees — the framer's
/// job, asserted through the send loop rather than around it.
#[test]
fn chunk_size_does_not_change_the_event_sequence() {
    let bytes = fixture("compaction_response.sse");
    let (whole, _) = drive(&mut Replay::bytes(bytes.clone(), bytes.len().max(1)));
    let (by_byte, _) = drive(&mut Replay::bytes(bytes.clone(), 1));
    let (by_seven, _) = drive(&mut Replay::bytes(bytes, 7));

    assert_eq!(
        whole, by_byte,
        "one byte at a time must match the whole body"
    );
    assert_eq!(whole, by_seven, "an odd chunk size must match too");
}

/// A retryable status is retried; `retry_delay` gets its first real caller.
#[test]
fn a_retryable_status_is_retried() {
    let bytes = fixture("omitted_thinking.sse");
    // First attempt: 429. Second: the real body.
    let mut source = Flaky {
        first: Replay::status(429, Some("0")),
        rest: Replay::bytes(bytes, 128),
        served: false,
    };

    let mut framer = SseFramer::new();
    let mut parser = AnthropicParser::new();
    let mut count = 0usize;
    let mut sink: StepSink = &mut |_| count += 1;
    let outcome =
        clauro_transport::send::stream_step(&mut source, &mut framer, &mut parser, &mut sink, 0);

    assert!(
        outcome.is_ok(),
        "a retry must eventually succeed: {outcome:?}"
    );
    assert_eq!(source.first.calls.get(), 1, "the 429 was tried once");
    assert!(count > 0, "the retried attempt still streamed events");
}

/// A 400 is not retryable: one attempt, typed error, no second request.
#[test]
fn a_non_retryable_status_fails_immediately() {
    let mut source = Replay::status(400, None);
    let (_seen, outcome) = drive(&mut source);

    assert!(
        matches!(outcome, Err(SendError::Status { status: 400, .. })),
        "typed status error, not a panic: {outcome:?}"
    );
    assert_eq!(source.calls.get(), 1, "no retry on a client error");
}

/// Attempts are capped: an unbounded retry is a hung turn, and `D56`'s policy
/// is a cap on tries, not only on delays.
#[test]
fn attempts_are_capped() {
    let mut source = AlwaysFailing {
        calls: std::cell::Cell::new(0),
        status: 429,
    };
    let (_seen, outcome) = drive(&mut source);

    assert!(outcome.is_err(), "a permanent 429 ends the step");
    assert_eq!(
        source.calls.get(),
        MAX_ATTEMPTS as usize,
        "capped at MAX_ATTEMPTS, not unbounded"
    );
}

/// The cap must report the status it actually kept hitting. A synthesised
/// "429" here would misdescribe a 503 outage in the transcript.
#[test]
fn the_cap_reports_the_status_that_was_actually_seen() {
    let mut source = AlwaysFailing {
        calls: std::cell::Cell::new(0),
        status: 503,
    };
    let (_seen, outcome) = drive(&mut source);

    assert_eq!(
        outcome,
        Err(SendError::Status {
            status: 503,
            retry_after: Some("0".to_string()),
        }),
        "the real status, not a hardcoded one"
    );
}

/// Two sources in one test file: a 429 then a success, and a permanent failure.
struct Flaky {
    first: Replay,
    rest: Replay,
    served: bool,
}

impl ByteSource for Flaky {
    fn attempt(&mut self) -> Result<Attempt, SendError> {
        if self.served {
            return self.rest.attempt();
        }
        self.served = true;
        self.first.attempt()
    }
}

struct AlwaysFailing {
    calls: std::cell::Cell<usize>,
    status: u16,
}

impl ByteSource for AlwaysFailing {
    fn attempt(&mut self) -> Result<Attempt, SendError> {
        self.calls.set(self.calls.get() + 1);
        Err(SendError::Status {
            status: self.status,
            retry_after: Some("0".to_string()),
        })
    }
}
