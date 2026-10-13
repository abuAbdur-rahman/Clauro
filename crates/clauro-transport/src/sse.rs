//! SSE framing: bytes become events. No provider knowledge lives here.
//!
//! Pipeline (`TECH_STACK.md` §3): bytes → incremental UTF-8 decode → line
//! frame → event parse. A chunk may split anywhere — mid-line, mid-field, or
//! mid-codepoint — so the framer buffers until a newline completes a line and
//! holds back an incomplete UTF-8 tail rather than emitting replacement
//! characters.

use std::fmt;

/// One dispatched SSE event: the `event:` type plus its `data:` lines joined
/// with `\n`. Absent `event:` defaults to `message` per the SSE spec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSseEvent {
    pub event_type: String,
    pub data: String,
}

/// An unterminated line may buffer at most this much before the framer
/// refuses it: a stream without newlines must not grow memory without limit.
pub const MAX_LINE_LEN: usize = 1024 * 1024;

/// One event's cumulative `data:` bytes may buffer at most this much before
/// the framer refuses it. Each individual line is capped by
/// [`MAX_LINE_LEN`], but a hostile stream can send `data: x\n` forever, and
/// `pending_data` would grow without limit between blank lines.
pub const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;

/// Why framing failed. The caller drops the framer after an error: resuming
/// mid-line would re-emit a prefix the transcript already judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramerError {
    LineTooLong(usize),
    EventTooLong(usize),
}

impl fmt::Display for FramerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LineTooLong(n) => write!(f, "unterminated line past {MAX_LINE_LEN} bytes ({n})"),
            Self::EventTooLong(n) => {
                write!(f, "event data past {MAX_EVENT_BYTES} bytes ({n})")
            }
        }
    }
}

impl std::error::Error for FramerError {}

/// Incremental framer. Feed arbitrary byte slices; take completed events.
pub struct SseFramer {
    /// Decoded but unprocessed text.
    text: String,
    /// Bytes held back: a UTF-8 sequence split across the chunk boundary.
    carry: Vec<u8>,
    pending_type: Option<String>,
    pending_data: Vec<String>,
    /// Cumulative bytes in `pending_data`, reset on dispatch.
    pending_bytes: usize,
    /// The previous terminator was a lone CR: a leading LF in the next
    /// chunk is the second half of that CRLF pair and is dropped.
    last_was_cr: bool,
}

impl SseFramer {
    #[must_use]
    pub fn new() -> Self {
        Self {
            text: String::new(),
            carry: Vec::new(),
            pending_type: None,
            pending_data: Vec::new(),
            pending_bytes: 0,
            last_was_cr: false,
        }
    }

    /// Append bytes, return every event completed by them. Fails instead of
    /// buffering an unterminated line past `MAX_LINE_LEN`.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<RawSseEvent>, FramerError> {
        self.carry.extend_from_slice(bytes);
        // Decode the longest valid prefix. `error_len` distinguishes real
        // damage (emit U+FFFD, move on) from a trailing split codepoint (hold
        // it back for the next feed).
        let carry = std::mem::take(&mut self.carry);
        let mut i = 0;
        let mut held: &[u8] = &[];
        while i < carry.len() {
            match std::str::from_utf8(&carry[i..]) {
                Ok(valid) => {
                    self.text.push_str(valid);
                    i = carry.len();
                }
                Err(e) => {
                    let up = e.valid_up_to();
                    self.text
                        .push_str(&String::from_utf8_lossy(&carry[i..i + up]));
                    match e.error_len() {
                        Some(len) => {
                            self.text.push('\u{FFFD}');
                            i += up + len;
                        }
                        // Incomplete tail: the valid prefix stays consumed;
                        // only the undecodable tail is held back.
                        None => {
                            held = &carry[i + up..];
                            break;
                        }
                    }
                }
            }
        }
        self.carry = held.to_vec();

        let mut out = Vec::new();
        // Line terminators are `\n`, `\r\n`, and a lone `\r` (SSE spec). A
        // CR terminates its line **eagerly**; a following LF — in this
        // buffer or the next feed — is the second half of a CRLF pair and
        // is dropped, never a second terminator.
        while let Some(pos) = self.text.find(['\r', '\n']) {
            let terminator_len = match self.text.as_bytes()[pos] {
                b'\n' if self.last_was_cr && pos == 0 => {
                    // LF half of a CRLF pair whose CR was already consumed.
                    self.last_was_cr = false;
                    self.text.drain(..1);
                    continue;
                }
                b'\n' => {
                    self.last_was_cr = false;
                    1
                }
                _ => {
                    let double = self.text.as_bytes().get(pos + 1) == Some(&b'\n');
                    // Consumed together → no LF left to drop; a lone CR
                    // leaves one pending for a possible next-feed LF.
                    self.last_was_cr = !double;
                    if double {
                        2
                    } else {
                        1
                    }
                }
            };
            let line: String = self.text.drain(..pos).collect();
            self.text.drain(..terminator_len);
            if let Some(event) = self.handle_line(&line) {
                out.push(event);
            }
            if self.pending_bytes > MAX_EVENT_BYTES {
                return Err(FramerError::EventTooLong(self.pending_bytes));
            }
        }
        if self.text.len() > MAX_LINE_LEN {
            return Err(FramerError::LineTooLong(self.text.len()));
        }
        Ok(out)
    }

    /// End of stream. A non-newline-terminated tail line is **discarded**,
    /// per the SSE spec: dispatching it would make a truncated stream look
    /// whole (audit 12). A pending event whose lines were all complete is
    /// still flushed.
    pub fn finish(&mut self) -> Vec<RawSseEvent> {
        self.text.clear();
        let mut out = Vec::new();
        if let Some(event) = self.dispatch() {
            out.push(event);
        }
        out
    }

    /// One line. Returns an event only on the blank line that dispatches it.
    fn handle_line(&mut self, line: &str) -> Option<RawSseEvent> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None; // comment / keepalive
        }
        if let Some(value) = line.strip_prefix("event:") {
            self.pending_type = Some(value.strip_prefix(' ').unwrap_or(value).to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            self.push_data(value.strip_prefix(' ').unwrap_or(value));
        } else if line == "data" {
            // A field with no colon carries the empty string, per spec —
            // it is not a drop.
            self.push_data("");
        } else if line == "event" {
            self.pending_type = Some(String::new());
        }
        // `id:` and `retry:` are ignored: v1 has no resume (deferred with
        // retries), and anything else unknown is ignored per SSE.
        None
    }

    fn push_data(&mut self, value: &str) {
        self.pending_bytes += value.len();
        self.pending_data.push(value.to_string());
    }

    fn dispatch(&mut self) -> Option<RawSseEvent> {
        if self.pending_data.is_empty() {
            self.pending_type = None;
            return None;
        }
        let data = std::mem::take(&mut self.pending_data).join("\n");
        self.pending_bytes = 0;
        if data.is_empty() {
            // Empty data buffer: per spec the event (and its type) is
            // discarded — a type-only event was never sent.
            self.pending_type = None;
            return None;
        }
        Some(RawSseEvent {
            event_type: match self.pending_type.take() {
                Some(t) if !t.is_empty() => t,
                _ => "message".to_string(),
            },
            data,
        })
    }
}

impl Default for SseFramer {
    fn default() -> Self {
        Self::new()
    }
}
