//! `clauro-core`: domain types. No I/O, no dependencies beyond `serde`.
//!
//! The type layer (`TECH_STACK.md` §2). Anything doing I/O, touching the
//! network, or knowing Tauri exists lives in another crate. The dependency
//! rule is mechanical, not conventional: see `tests/no_extra_deps.rs`.

use serde::{Deserialize, Serialize};

/// A placeholder proving the crate compiles and tests run headless.
/// Real domain types (`ContentBlock`, `ToolOutcome`, `Measurement`) land with
/// the tasks that own them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placeholder {
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_behaves() {
        // No serde_json here on purpose: this crate depends on nothing but
        // `serde`, and the test must not smuggle in a second dependency.
        let p = Placeholder {
            name: "headless".to_string(),
        };
        assert_eq!(p.clone(), p);
        assert!(format!("{p:?}").contains("headless"));
    }
}
