//! Secret-shaped input is refused, silently (D43).
//!
//! The guard is a predicate, not a judgement call: government ID numbers,
//! financial account numbers, criminal-history and immigration-status
//! statements, and anything shaped like a live key or token. Refusal is
//! silent to the model — the tools return a typed `error` and nothing else,
//! so probing cannot map the guard. Benign look-alikes (a 40-hex commit SHA,
//! `ski` next to `sk-`) must pass, or the guard gets turned off.

/// True iff `s` is shaped like a secret the store must never persist.
#[must_use]
pub fn looks_secret(s: &str) -> bool {
    // PEM / private-key headers.
    if s.contains("-----BEGIN PRIVATE KEY-----") || s.contains("-----BEGIN RSA PRIVATE KEY-----") {
        return true;
    }
    // Live key/token prefixes.
    for prefix in [
        "sk-",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxr-",
        "xoxs-",
        "AKIA",
    ] {
        if s.contains(prefix) {
            return true;
        }
    }
    // `passphrase` / private-key words adjacent to an assignment.
    let lower = s.to_lowercase();
    for word in ["passphrase", "private key", "private_key"] {
        if let Some(pos) = lower.find(word) {
            let after = &lower[pos + word.len()
                ..pos + word.len() + 12.min(lower.len().saturating_sub(pos + word.len()))];
            if after.contains('=') || after.contains(':') {
                return true;
            }
        }
    }
    // Government ID numbers: SSN shape.
    if has_ssn(s) {
        return true;
    }
    // Financial accounts: 13–19 digit runs with optional separators, and IBANs.
    if has_card_run(s) || has_iban(s) {
        return true;
    }
    // Criminal-history and immigration-status statements.
    for phrase in ["criminal history", "immigration status", "asylum"] {
        if lower.contains(phrase) {
            return true;
        }
    }
    // Long high-entropy runs with no spaces. A 40/64-hex run in commit
    // context is a git SHA, not a secret — everything else that long and that
    // dense is refused.
    if has_dense_run(s) && !is_sha_in_context(&lower) {
        return true;
    }
    false
}

fn has_ssn(s: &str) -> bool {
    let b = s.as_bytes();
    b.windows(11).any(|w| {
        w[3] == b'-'
            && w[6] == b'-'
            && w[..3].iter().all(|c| c.is_ascii_digit())
            && w[4..6].iter().all(|c| c.is_ascii_digit())
            && w[7..].iter().all(|c| c.is_ascii_digit())
    })
}

fn has_card_run(s: &str) -> bool {
    // Runs of digits, spaces, and dashes, 13–19 digits total.
    for token in s.split(|c: char| !c.is_ascii_alphanumeric() && c != ' ' && c != '-') {
        let digits: String = token.chars().filter(|c| c.is_ascii_digit()).collect();
        if (13..=19).contains(&digits.len()) && !token.trim().is_empty() {
            // Must actually contain separators or be all digits (avoid words).
            if digits.len() == token.chars().filter(|c| !c.is_whitespace()).count()
                || token.contains([' ', '-'])
            {
                return true;
            }
        }
    }
    false
}

/// IBAN: two letters, two digits, then 11–30 alphanumerics.
fn has_iban(s: &str) -> bool {
    let upper: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let b = upper.as_bytes();
    for i in 0..b.len().saturating_sub(15) {
        if b[i].is_ascii_uppercase()
            && b.get(i + 1).is_some_and(|c| c.is_ascii_uppercase())
            && b.get(i + 2).is_some_and(|c| c.is_ascii_digit())
            && b.get(i + 3).is_some_and(|c| c.is_ascii_digit())
        {
            let tail: usize = b[i + 4..]
                .iter()
                .take_while(|c| c.is_ascii_alphanumeric())
                .count();
            if (11..=30).contains(&tail) {
                return true;
            }
        }
    }
    false
}

fn has_dense_run(s: &str) -> bool {
    s.split_whitespace().any(|tok| {
        let tok = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && !"+/=_-".contains(c));
        tok.len() >= 32
            && tok
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+/=_-".contains(c))
    })
}

/// A 40- or 64-hex run next to commit/sha/hash talk is a git SHA.
fn is_sha_in_context(lower: &str) -> bool {
    let context = lower.contains("commit") || lower.contains("sha") || lower.contains("hash");
    if !context {
        return false;
    }
    lower.split_whitespace().any(|tok| {
        (tok.len() == 40 || tok.len() == 64) && tok.chars().all(|c| c.is_ascii_hexdigit())
    })
}
