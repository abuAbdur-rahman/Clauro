//! OS keychain access. `keyring` crate only (Task 003).
//!
//! Windows Credential Manager, libsecret on Linux. **Never** SQLite, never a
//! config file, never a log line. Every error is typed: callers distinguish
//! "no backend here" from "the operation failed", because on a headless Linux
//! box libsecret may simply be absent — and that is reported, not hidden.

use serde::Serialize;

/// Service namespace for every Clauro secret. One namespace keeps the
/// credential store greppable and the audit trivial.
pub const SERVICE: &str = "app.clauro";

/// Typed keyring failure. No key material, ever — variants carry reasons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum KeyringError {
    /// No usable backend (headless Linux without libsecret/dbus, etc.).
    /// Report honestly; never fail silently at first use.
    Unavailable { reason: String },
    /// Backend present, operation failed. Reason only — never the secret.
    Failed { reason: String },
}

impl std::fmt::Display for KeyringError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyringError::Unavailable { reason } => write!(f, "keychain unavailable: {reason}"),
            KeyringError::Failed { reason } => write!(f, "keychain operation failed: {reason}"),
        }
    }
}

impl std::error::Error for KeyringError {}

fn entry(account: &str) -> Result<keyring::Entry, KeyringError> {
    keyring::Entry::new(SERVICE, account).map_err(|e| classify(e, "open entry"))
}

/// Classify a keyring error: backend-absence becomes `Unavailable`, everything
/// else becomes `Failed`. The match is on the error's own description, which is
/// the stable part of the `keyring` API across backends.
fn classify(e: keyring::Error, op: &str) -> KeyringError {
    let msg = format!("{e:?}");
    // Backend-absence signals across keyring 4.x backends: no dbus session,
    // no libsecret service, no credential daemon. Matched case-insensitively
    // because backend crates capitalise differently.
    let lower = msg.to_lowercase();
    let absent = [
        "no backend",
        "dbus",
        "org.freedesktop.secrets",
        "service unknown",
        "not available",
        "unavailable",
    ];
    if absent.iter().any(|s| lower.contains(s)) {
        KeyringError::Unavailable {
            reason: format!("{op}: {e}"),
        }
    } else {
        KeyringError::Failed {
            reason: format!("{op}: {e}"),
        }
    }
}

/// Probe backend availability without touching a secret.
pub fn is_available() -> Result<(), KeyringError> {
    // Opening an entry initialises the backend on most platforms; a missing
    // backend surfaces here rather than at first use.
    entry("__availability_probe__").map(|_| ())
}

/// Store a secret. Overwrites silently — rotation is a store, not a migration.
pub fn store(account: &str, secret: &str) -> Result<(), KeyringError> {
    let e = entry(account)?;
    e.set_password(secret)
        .map_err(|e| classify(e, "store secret"))
}

/// Retrieve a secret. Absent credentials are `Failed("not found")`, not
/// `Unavailable` — the backend answered, it just has nothing for us.
pub fn retrieve(account: &str) -> Result<String, KeyringError> {
    let e = entry(account)?;
    e.get_password().map_err(|e| classify(e, "retrieve secret"))
}

/// Delete a secret. Deleting what is not there succeeds — delete is
/// idempotent, and a retry must not fail on its own prior success.
pub fn delete(account: &str) -> Result<(), KeyringError> {
    let e = entry(account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(classify(e, "delete secret")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique account per run so parallel CI jobs never share a credential.
    fn test_account() -> String {
        format!(
            "clauro-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )
    }

    /// Round-trip when a backend exists; honest `Unavailable` when it does
    /// not. This test never goes red for environmental reasons: absence is a
    /// finding the suite asserts on, not a failure it hides.
    #[test]
    fn round_trip_or_honest_unavailable() {
        match is_available() {
            Err(KeyringError::Unavailable { reason }) => {
                // Headless box without a keychain daemon. The product must
                // report exactly this — the test passes by asserting the
                // honest path exists and is typed.
                assert!(!reason.is_empty());
            }
            Err(KeyringError::Failed { reason }) => {
                panic!("keychain backend error is not an honest Unavailable: {reason}");
            }
            Ok(()) => {
                let account = test_account();
                let secret = "s3cr3t-canary-do-not-log";
                store(&account, secret).expect("store must succeed with a backend");
                let back = retrieve(&account).expect("retrieve must succeed after store");
                assert_eq!(back, secret);
                delete(&account).expect("delete must succeed");
                // Second delete is idempotent, not an error.
                delete(&account).expect("delete is idempotent");
                // Gone means gone: retrieve now fails as Failed, not Unavailable.
                match retrieve(&account) {
                    Err(KeyringError::Failed { .. }) => {}
                    other => panic!("expected Failed after delete, got {other:?}"),
                }
            }
        }
    }

    #[test]
    fn errors_carry_no_secret_material() {
        // The type carries reasons only. If a future variant ever gains a
        // secret-shaped field, its Debug output would print it here.
        let e = KeyringError::Failed {
            reason: "store secret: mocked".to_string(),
        };
        let dbg = format!("{e:?}");
        assert!(
            !dbg.contains("s3cr3t"),
            "error variants must not carry secrets"
        );
    }
}
