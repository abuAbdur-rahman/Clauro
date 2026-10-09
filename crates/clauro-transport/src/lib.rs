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
    build_compaction_request, build_normal_request, validate_compaction_swap, BuiltRequest,
    CompactionBuildError, CompactionBuildInput, CompactionSwapError, NormalBuildInput,
    ThinkingConfig, MAX_COMPACTION_INSTRUCTIONS, THINKING_BINDING_BETA,
};
pub use capabilities::{compaction_path, select_compaction_path, CompactionPath};
pub use openai_compat::OpenAiParser;
pub use retry::{retry_delay, MAX_ATTEMPTS};
pub use sse::{FramerError, RawSseEvent, SseFramer, MAX_LINE_LEN};

use std::fmt;

/// Every failure this crate can produce. Nothing crosses to callers untyped.
#[derive(Debug)]
pub enum TransportError {
    /// The HTTP client itself could not be constructed.
    ClientBuild(String),
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClientBuild(e) => write!(f, "http client build failed: {e}"),
        }
    }
}

impl std::error::Error for TransportError {}

/// One shared client: rustls, webpki roots, streaming bodies. Construction
/// performs no I/O, so this is testable without a network.
pub fn client() -> Result<reqwest::Client, TransportError> {
    reqwest::Client::builder()
        .build()
        .map_err(|e| TransportError::ClientBuild(e.to_string()))
}
