//! Audit 12/finding 1 — the retry wrapper hard-enforces `MAX_ATTEMPTS` (RED).
//!
//! The capped loop `stream_step` has no production caller; the live loop in
//! `src-tauri/src/turn.rs` calls `retry_delay` directly and never checks the
//! attempt budget, so a permanently-429 provider sleeps forever. This file
//! pins the crate-side seam the live path must be routed through: an injected
//! failing transport, a hard cap, and a typed error after it.

use clauro_transport::send::{run_with_retry, SendError};
use clauro_transport::{TransportError, MAX_ATTEMPTS};
use std::cell::Cell;

/// A transport that fails every attempt with a retryable status.
/// `Retry-After: 0` means "retry now", so the cap is provable without
/// sleeping through real backoff delays.
fn always_429(calls: &Cell<u32>) -> impl FnMut(u32) -> Result<(), SendError> + '_ {
    move |_| {
        calls.set(calls.get() + 1);
        Err(SendError::Status {
            status: 429,
            retry_after: Some("0".to_string()),
        })
    }
}

#[test]
fn a_permanently_429_provider_is_capped_not_retried_forever() {
    let calls = Cell::new(0u32);
    let outcome = run_with_retry(always_429(&calls));

    assert!(
        matches!(
            outcome,
            Err(TransportError::RetriesExhausted {
                attempts,
                status: 429,
                ..
            }) if attempts == MAX_ATTEMPTS
        ),
        "typed error after the cap, naming the status: {outcome:?}"
    );
    assert_eq!(
        calls.get(),
        MAX_ATTEMPTS,
        "exactly MAX_ATTEMPTS tries — an unbounded retry is a hung turn (D56)"
    );
}

#[test]
fn a_503_outage_reports_the_status_actually_seen() {
    let calls = Cell::new(0u32);
    let outcome: Result<(), TransportError> = run_with_retry(|_| {
        calls.set(calls.get() + 1);
        Err(SendError::Status {
            status: 503,
            // "retry now" — the backoff table itself is tested in retry.rs;
            // this test only pins that the cap reports the real status.
            retry_after: Some("0".to_string()),
        })
    });

    assert!(
        matches!(
            outcome,
            Err(TransportError::RetriesExhausted { status: 503, .. })
        ),
        "the real status, not a synthesised 429: {outcome:?}"
    );
}

#[test]
fn success_before_the_cap_costs_only_the_attempts_it_used() {
    let calls = Cell::new(0u32);
    let outcome = run_with_retry(|attempt| {
        calls.set(calls.get() + 1);
        if attempt < 2 {
            Err(SendError::Status {
                status: 429,
                retry_after: Some("0".to_string()),
            })
        } else {
            Ok(attempt)
        }
    });

    assert!(
        matches!(outcome, Ok(2)),
        "two retries then success: {outcome:?}"
    );
    assert_eq!(calls.get(), 3, "three attempts total");
}

#[test]
fn a_non_retryable_status_passes_through_after_one_attempt() {
    let calls = Cell::new(0u32);
    let outcome: Result<(), TransportError> = run_with_retry(|_| {
        calls.set(calls.get() + 1);
        Err(SendError::Status {
            status: 400,
            retry_after: None,
        })
    });

    assert!(
        matches!(
            outcome,
            Err(TransportError::Send(SendError::Status { status: 400, .. }))
        ),
        "a 400 surfaces unchanged, never as RetriesExhausted: {outcome:?}"
    );
    assert_eq!(calls.get(), 1, "no retry on a client error (D56)");
}

#[test]
fn a_transport_failure_never_loops_on_a_dns_error() {
    let calls = Cell::new(0u32);
    let outcome: Result<(), TransportError> = run_with_retry(|_| {
        calls.set(calls.get() + 1);
        Err(SendError::Transport("refused".to_string()))
    });

    assert!(
        matches!(outcome, Err(TransportError::Send(SendError::Transport(_)))),
        "no status exists to back off on: {outcome:?}"
    );
    assert_eq!(calls.get(), 1, "one attempt, reported at once");
}
