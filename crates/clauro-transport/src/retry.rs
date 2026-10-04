//! Retry policy: delay or give up, nothing else (D56).
//!
//! Transport-level backoff on 429/5xx honouring `Retry-After`. No agent-level
//! retry concept exists in v1 — the loop only ever sees a request fail or a
//! stream arrive. Pure function, table-tested, no clock and no network: the
//! caller supplies `now`, the HTTP layer (006) supplies the sleep.

use std::time::Duration;

/// Upper bound on attempts. The policy caps delays; the caller caps tries.
pub const MAX_ATTEMPTS: u32 = 5;

const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 60_000;
/// Even an explicit server ask waits no longer than this per attempt.
const RETRY_AFTER_CAP_SECS: u64 = 300;

/// How long to wait before the next attempt, or `None` to give up now.
/// `attempt` is zero-based. No jitter: a single desktop client has no
/// thundering herd to decorrelate from.
#[must_use]
pub fn retry_delay(
    status: u16,
    retry_after: Option<&str>,
    attempt: u32,
    now_epoch_secs: u64,
) -> Option<Duration> {
    if !matches!(status, 408 | 429 | 500..=599) {
        return None;
    }
    if let Some(header) = retry_after {
        if let Some(secs) = parse_retry_after(header, now_epoch_secs) {
            return Some(Duration::from_secs(secs.min(RETRY_AFTER_CAP_SECS)));
        }
    }
    let shift = attempt.min(10);
    let backoff = BACKOFF_BASE_MS
        .saturating_mul(1 << shift)
        .min(BACKOFF_CAP_MS);
    Some(Duration::from_millis(backoff))
}

/// `Retry-After`: delay-seconds or an HTTP date. Past dates and garbage fall
/// back to backoff (`None` here means "no header value", not "give up").
fn parse_retry_after(header: &str, now_epoch_secs: u64) -> Option<u64> {
    let header = header.trim();
    if let Ok(secs) = header.parse::<u64>() {
        return Some(secs);
    }
    http_date_epoch(header).and_then(|then| then.checked_sub(now_epoch_secs))
}

/// `Wed, 21 Oct 2015 07:28:00 GMT`. Hand-rolled: one date format, no chrono
/// for a single header.
fn http_date_epoch(header: &str) -> Option<u64> {
    let rest = header.split_once(", ")?.1.strip_suffix(" GMT")?;
    let mut parts = rest.split(' ');
    let day: i64 = parts.next()?.parse().ok()?;
    let month: i64 = match parts.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts.next()?.parse().ok()?;
    let mut time = parts.next()?.split(':');
    let (h, m, s): (i64, i64, i64) = (
        time.next()?.parse().ok()?,
        time.next()?.parse().ok()?,
        time.next()?.parse().ok()?,
    );
    if !(1..=31).contains(&day)
        || !(0..24).contains(&h)
        || !(0..60).contains(&m)
        || !(0..60).contains(&s)
    {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm), proleptic Gregorian.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9).rem_euclid(12);
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86_400 + h * 3_600 + m * 60 + s).ok()
}
