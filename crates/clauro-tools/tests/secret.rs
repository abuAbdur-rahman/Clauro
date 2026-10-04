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
    ] {
        assert!(!looks_secret(s), "must allow: {s}");
    }
}
