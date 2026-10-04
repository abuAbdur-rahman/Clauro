//! Task 005 — transport retry is a pure policy (RED).
//!
//! Backoff on 429/5xx honouring `Retry-After` (D56). No agent-level retry
//! concept: the loop only ever sees a request fail or a stream arrive, so the
//! policy decides delay-or-give-up and nothing else. Pure function, table
//! tested, no network.

use clauro_transport::{retry_delay, MAX_ATTEMPTS};
use std::time::Duration;

#[test]
fn retry_after_seconds_win() {
    assert_eq!(
        retry_delay(429, Some("2"), 0, 1_000_000),
        Some(Duration::from_secs(2))
    );
}

#[test]
fn retry_after_http_date_counts_down_to_now() {
    // 1_000_000 = Mon, 12 Jan 1970 13:46:40 GMT; the header is +5s.
    assert_eq!(
        retry_delay(503, Some("Mon, 12 Jan 1970 13:46:45 GMT"), 0, 1_000_000),
        Some(Duration::from_secs(5))
    );
}

#[test]
fn backoff_doubles_capped_at_sixty() {
    assert_eq!(retry_delay(503, None, 0, 0), Some(Duration::from_secs(1)));
    assert_eq!(retry_delay(503, None, 1, 0), Some(Duration::from_secs(2)));
    assert_eq!(retry_delay(500, None, 2, 0), Some(Duration::from_secs(4)));
    assert_eq!(retry_delay(408, None, 1, 0), Some(Duration::from_secs(2)));
    assert_eq!(
        retry_delay(503, None, 10, 0),
        Some(Duration::from_secs(60)),
        "backoff caps, it never walks away silently"
    );
}

#[test]
fn past_date_falls_back_to_backoff() {
    assert_eq!(
        retry_delay(429, Some("Mon, 12 Jan 1970 13:46:30 GMT"), 0, 1_000_000),
        Some(Duration::from_secs(1))
    );
}

#[test]
fn non_retryable_statuses_give_up_immediately() {
    for status in [200, 400, 401, 403, 404] {
        assert_eq!(
            retry_delay(status, None, 0, 0),
            None,
            "{status} must not retry"
        );
        assert_eq!(
            retry_delay(status, Some("5"), 0, 0),
            None,
            "{status} must not retry even with Retry-After"
        );
    }
}

#[test]
fn attempt_budget_is_bounded() {
    const {
        assert!(MAX_ATTEMPTS > 0 && MAX_ATTEMPTS <= 8);
    }
}
