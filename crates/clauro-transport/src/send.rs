//! The send loop: HTTP status → bytes → framed events → a sink (D56).
//!
//! This is the layer that was missing entirely. `retry_delay` had a table test
//! and no caller, because nothing in the repo opened a socket; a turn could
//! only be driven by a scripted `Exchange` in a test.
//!
//! Split deliberately:
//! - [`ByteSource`] is the only part that touches the network. The real one
//!   lives in `src-tauri` (it owns the keyring and the reqwest client); the
//!   tests supply fixture bytes. So every rule below is provable without a
//!   socket and without a key.
//! - [`stream_step`] is the loop: attempt, check status, frame bytes, parse,
//!   and hand each event to the sink **as it is produced**.
//!
//! Status handling is `retry_delay`'s, unchanged and un-copied (`D56`): a
//! retryable status backs off and retries, a non-retryable one fails at once,
//! and attempts are capped by `MAX_ATTEMPTS` — a cap on tries, not only on
//! delays, because an uncapped retry is a hung turn.
//!
//! The framer is owned by the caller and passed in, because a resume must keep
//! its buffer: dropping it mid-line would re-emit a prefix the transcript has
//! already judged.

use crate::anthropic::{NormalisedEvent, StreamParser};
use crate::retry::{retry_delay, MAX_ATTEMPTS};
use crate::sse::SseFramer;

/// A sink for one step's events. Called once per event, in order, as the event
/// is produced — this is what makes a turn render instead of appearing whole at
/// `end_turn`.
pub type StepSink<'a> = &'a mut dyn FnMut(NormalisedEvent);

/// One successful HTTP response: a 2xx status and its body in chunks.
pub struct Attempt {
    pub status: u16,
    pub retry_after: Option<String>,
    pub chunks: std::vec::IntoIter<Vec<u8>>,
}

/// Why a step could not be completed. Every variant is typed and model-visible
/// at the transcript layer; nothing here panics or hangs (`D55`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// A non-retryable status, or one that stayed retryable to the attempt cap.
    Status {
        status: u16,
        retry_after: Option<String>,
    },
    /// The transport failed before a status existed (DNS, TLS, connection).
    Transport(String),
    /// The framer refused a line. Drop the framer: resuming mid-line would
    /// replay a prefix the transcript already judged.
    Frame(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status {
                status,
                retry_after,
            } => match retry_after {
                Some(after) => write!(f, "provider returned HTTP {status} (retry after {after})"),
                None => write!(f, "provider returned HTTP {status}"),
            },
            Self::Transport(reason) => write!(f, "connection failed: {reason}"),
            Self::Frame(reason) => write!(f, "stream framing failed: {reason}"),
        }
    }
}

impl std::error::Error for SendError {}

/// The network half of one step. Implemented over `reqwest::blocking` in the
/// shell crate, and over fixture bytes in tests.
pub trait ByteSource {
    /// Make one attempt. A non-2xx status is returned as
    /// [`SendError::Status`], never as an `Attempt` — so a caller cannot
    /// accidentally parse an error body as a transcript.
    fn attempt(&mut self) -> Result<Attempt, SendError>;
}

/// Run one step to completion, streaming every event to `sink`.
///
/// `attempt` is the zero-based attempt index the caller is resuming at; a
/// resume after a transport failure passes the count it already spent, so the
/// cap counts attempts across the whole step rather than restarting.
///
/// Returns the number of attempts spent. A caller that wants the events must
/// read them from its own sink — the return value is a tally, not the stream.
pub fn stream_step(
    source: &mut dyn ByteSource,
    framer: &mut SseFramer,
    parser: &mut dyn StreamParser,
    sink: StepSink<'_>,
    mut attempt: u32,
) -> Result<u32, SendError> {
    let mut now = epoch_secs();
    // The status we last saw, so hitting the cap reports what actually
    // happened rather than a synthesised one.
    let mut last: Option<(u16, Option<String>)> = None;
    loop {
        if attempt >= MAX_ATTEMPTS {
            let (status, retry_after) = last.unwrap_or((429, None));
            return Err(SendError::Status {
                status,
                retry_after,
            });
        }
        match source.attempt() {
            Ok(ok) => {
                for chunk in ok.chunks {
                    let raw = framer
                        .feed(&chunk)
                        .map_err(|e| SendError::Frame(e.to_string()))?;
                    for event in raw {
                        for normalised in parser.feed(&event) {
                            sink(normalised);
                        }
                    }
                }
                // Flush the framer's tail: a final event may not end in a
                // blank line, and dropping it would truncate the transcript.
                let tail = framer.finish();
                for event in tail {
                    for normalised in parser.feed(&event) {
                        sink(normalised);
                    }
                }
                return Ok(attempt + 1);
            }
            Err(err) => {
                let (status, retry_after) = match &err {
                    SendError::Status {
                        status,
                        retry_after,
                    } => (*status, retry_after.clone()),
                    // A transport failure has no status to back off on; report
                    // it rather than looping on a DNS error until the cap.
                    _ => return Err(err),
                };
                last = Some((status, retry_after.clone()));
                let delay = retry_delay(status, retry_after.as_deref(), attempt, now);
                match delay {
                    Some(d) => {
                        sleep(d);
                        now = epoch_secs();
                        attempt += 1;
                    }
                    None => {
                        return Err(SendError::Status {
                            status,
                            retry_after,
                        })
                    }
                }
            }
        }
    }
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The one sleep in the send path. Isolated so a test can pin the policy
/// without waiting on it.
fn sleep(d: std::time::Duration) {
    // `Retry-After: 0` is a legitimate server answer meaning "retry now", and
    // the fixture tests rely on it. Anything else is a real wait.
    if d.is_zero() {
        return;
    }
    std::thread::sleep(d);
}
