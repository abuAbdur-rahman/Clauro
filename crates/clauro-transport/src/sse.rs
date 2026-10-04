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

/// Why framing failed. The caller drops the framer after an error: resuming
/// mid-line would re-emit a prefix the transcript already judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramerError {
    LineTooLong(usize),
}

impl fmt::Display for FramerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LineTooLong(n) => write!(f, "unterminated line past {MAX_LINE_LEN} bytes ({n})"),
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
}

impl SseFramer {
    #[must_use]
    pub fn new() -> Self {
        Self {
            text: String::new(),
            carry: Vec::new(),
            pending_type: None,
            pending_data: Vec::new(),
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
        while let Some(pos) = self.text.find('\n') {
            let mut line: String = self.text.drain(..=pos).collect();
            line.pop(); // the newline
            if line.ends_with('\r') {
                line.pop();
            }
            if let Some(event) = self.handle_line(&line) {
                out.push(event);
            }
        }
        if self.text.len() > MAX_LINE_LEN {
            return Err(FramerError::LineTooLong(self.text.len()));
        }
        Ok(out)
    }

    /// End of stream: dispatch a final event if lines are still pending.
    pub fn finish(&mut self) -> Vec<RawSseEvent> {
        let mut out = Vec::new();
        if !self.text.is_empty() {
            let line = std::mem::take(&mut self.text);
            if let Some(event) = self.handle_line(line.trim_end_matches('\r')) {
                out.push(event);
            }
        }
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
            self.pending_data
                .push(value.strip_prefix(' ').unwrap_or(value).to_string());
        }
        // `id:` and `retry:` are ignored: v1 has no resume (deferred with
        // retries), and anything else unknown is ignored per SSE.
        None
    }

    fn dispatch(&mut self) -> Option<RawSseEvent> {
        if self.pending_type.is_none() && self.pending_data.is_empty() {
            return None;
        }
        Some(RawSseEvent {
            event_type: self
                .pending_type
                .take()
                .unwrap_or_else(|| "message".to_string()),
            data: std::mem::take(&mut self.pending_data).join("\n"),
        })
    }
}

impl Default for SseFramer {
    fn default() -> Self {
        Self::new()
    }
}
