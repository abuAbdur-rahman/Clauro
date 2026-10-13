//! `clauro-transport`: SSE framing plus the two provider adapters.
//!
//! Hand-rolled SSE over `reqwest` with rustls — no OpenSSL system dependency
//! for cross-distro packaging (D24, `TECH_STACK.md` §3). `reqwest-sse` is
//! maintained but framing-only; the four parser rules in `anthropic` are
//! event semantics we own either way (D97).
//!
//! `cargo test` needs no network: every decision (framing, parsing, request
//! shape, retry delay, capability path) is a pure function over injected
//! bytes. The async send loop lands with the transcript consumer in 006.

pub mod anthropic;
pub mod build;
pub mod capabilities;
pub mod openai_compat;
pub mod openai_request;
pub mod retry;
pub mod send;
pub mod sse;

pub use anthropic::{
    AnthropicParser, InboundKind, IterationUsage, NormalisedEvent, StreamParser, ToolHeader,
    UsageWire,
};
pub use build::{
    build_compaction_request, build_normal_request, try_build_normal_request,
    validate_compaction_swap, BuiltRequest, CompactionBuildError, CompactionBuildInput,
    CompactionSwapError, NormalBuildError, NormalBuildInput, ThinkingConfig,
    MAX_COMPACTION_INSTRUCTIONS, THINKING_BINDING_BETA,
};
pub use capabilities::{compaction_path, select_compaction_path, CompactionPath};
pub use openai_compat::OpenAiParser;
pub use retry::{retry_delay, MAX_ATTEMPTS};
pub use send::run_with_retry;
pub use sse::{FramerError, RawSseEvent, SseFramer, MAX_EVENT_BYTES, MAX_LINE_LEN};

use std::fmt;

/// Every failure this crate can produce. Nothing crosses to callers untyped.
#[derive(Debug)]
pub enum TransportError {
    /// The HTTP client itself could not be constructed.
    ClientBuild(String),
    /// A send-layer failure surfaced unchanged through the retry wrapper.
    Send(send::SendError),
    /// The hard attempt cap ([`MAX_ATTEMPTS`]) was reached on a provider
    /// that kept returning a retryable status (D56). The turn ends here by
    /// policy instead of sleeping forever.
    RetriesExhausted {
        attempts: u32,
        status: u16,
        retry_after: Option<String>,
    },
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClientBuild(e) => write!(f, "http client build failed: {e}"),
            Self::Send(e) => write!(f, "{e}"),
            Self::RetriesExhausted {
                attempts,
                status,
                retry_after,
            } => match retry_after {
                Some(after) => write!(
                    f,
                    "retries exhausted after {attempts} attempts (last: HTTP {status}, retry after {after})"
                ),
                None => write!(
                    f,
                    "retries exhausted after {attempts} attempts (last: HTTP {status})"
                ),
            },
        }
    }
}

impl std::error::Error for TransportError {}

/// One shared client: rustls, webpki roots, streaming bodies. Construction
/// performs no I/O, so this is testable without a network.
///
/// Timeouts are per-phase, never one total-request cap (audit 12): a
/// legitimately long stream keeps flowing between chunks, while a stalled
/// connection fails in minutes rather than freezing the turn. The blocking
/// client in the shell crate must apply the same two timeouts.
pub fn client() -> Result<reqwest::Client, TransportError> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| TransportError::ClientBuild(e.to_string()))
}
