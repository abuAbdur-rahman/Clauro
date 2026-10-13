//! Task 008 — secret-shaped input is refused, silently (RED).
//!
//! The predicate, not a judgement call (`CONTRACTS.md` §3): government IDs,
//! financial accounts, criminal-history and immigration statements, live
//! keys. Refusal is silent to the model — a typed `error` and nothing else,
//! so probing cannot map the guard. Benign look-alikes must pass, or the
//! guard gets turned off.

use clauro_tools::looks_secret;

#[test]
fn live_keys_refused() {
    for s in [
        "sk-live-abc123xyz456789",
        "ghp_abcdefghij1234567890",
        "github_pat_abcdefghij1234567890abcdef",
        "xoxb-1234-5678-abcd",
        "AKIAIOSFODNN7EXAMPLE",
        "-----BEGIN PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE KEY-----",
        "api_key = \"abcdef1234567890abcdef1234567890\"",
        "passphrase = hunter2-hunter2-hunter2-hunter2",
    ] {
        assert!(looks_secret(s), "must refuse: {s}");
    }
}

#[test]
fn identity_and_financial_shapes_refused() {
    for s in [
        "ssn 123-45-6789",
        "card 4111-1111-1111-1111",
        "IBAN DE89370400440532013000 transfer",
        "criminal history: convicted 2020",
        "immigration status: pending asylum",
    ] {
        assert!(looks_secret(s), "must refuse: {s}");
    }
}

#[test]
fn high_entropy_runs_refused() {
    assert!(looks_secret("token abcdef1234567890ABCDEF1234567890"));
    assert!(looks_secret("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"));
}

#[test]
fn benign_lookalikes_allowed() {
    for s in [
        "commit a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
        "the task is pending",
        "asked about ski lessons",
        "passphrase is a word here", // no assignment, no secret material
        "remember 2-3 ideas for dinner",
        "id 42",
        // `sk-` inside a longer word is not a key prefix (audit 10 NIT):
        // hyphenated ordinary words must not silently refuse.
        "the task-is-pending list",
        "ask-for directions",
    ] {
        assert!(!looks_secret(s), "must allow: {s}");
    }
}

#[test]
fn key_prefixes_require_a_word_boundary() {
    // Real keys stand alone; `task-x` must not be eaten by the `sk-` check.
    for s in [
        "sk-live-abc123xyz456789",
        "the key is sk-live-abc123xyz456789 ok",
        "\"sk-live-abc123xyz456789\"",
        "=sk-live-abc123xyz456789",
    ] {
        assert!(looks_secret(s), "must refuse: {s}");
    }
    for s in [
        "the task-is-pending list",
        "ask-for directions",
        "a1AKIAIOSFODNN7EXAMPLEa1", // embedded, no boundary
    ] {
        assert!(!looks_secret(s), "must allow: {s}");
    }
}

#[test]
fn multibyte_input_never_panics_at_any_byte_index() {
    // audit 10 / 01 critical 13: the assignment window after
    // `passphrase` / `private key` / `private_key` was sliced by raw byte
    // count; a multi-byte char inside the window split a codepoint and
    // PANICKED — while the caller's shared Store mutex was held, poisoning
    // it and bricking every handler until restart. Every offset must be
    // boundary-safe now. "ø"(2B) "你"(3B) "𝄞"(4B) cover all widths.
    for word in ["passphrase", "private key", "private_key"] {
        for len in 0..48usize {
            let filler: String = "ø你𝄞".chars().cycle().take(len).collect();
            for tail in ["", "=", ":", " = x", "：密", "你"] {
                let s = format!("{word}{filler}{tail}");
                let _ = looks_secret(&s); // must not panic
            }
        }
    }
    // Same shapes at the top level and preceded by arbitrary text, so the
    // find-position is not always zero.
    for pad in 0..8usize {
        let prefix = "a".repeat(pad);
        let s = format!("{prefix}note: passphrase {}", "ø".repeat(30));
        let _ = looks_secret(&s);
    }
}
