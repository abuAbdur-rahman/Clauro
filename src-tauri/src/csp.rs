//! CSP assembly for the shell and the artifact frame (D3, D78, D108).
//!
//! **Assembled here, not in the web app.** A policy written in TypeScript is a
//! string the front end could simply not send; one written in Rust is the only
//! copy, and the webview applies it to the document whether or not the page
//! cooperates. The artifact's policy is delivered as a value the front end
//! embeds — and the test below asserts the TypeScript never hardcodes a
//! directive, so "assembled in Rust" is a checked property and not a promise.
//!
//! **Two policies, because they are different boundaries.** `app_csp` governs
//! the shell, which must reach Tauri IPC and its own assets. `artifact_csp`
//! governs the sandboxed frame, which must reach *nothing*: `D3`'s
//! `connect-src 'none'`, images only as `data:`/`blob:`, no form posts, no
//! plugins, no `<base>` to re-point every relative URL in the document.
//!
//! **`dangerousDisableAssetCspModification` is never set (D78).** It exists in
//! the Tauri config for projects that serve content over the asset protocol;
//! artifact documents are served from a dedicated custom scheme with their own
//! header policy, so there is nothing to disable, and the boolean form
//! of the flag would switch off nonce injection app-wide. If a future change
//! needs it, pass the *named directives* as a list.

/// Directives the artifact policy must contain, per `D3` and SPEC A4.
// Only the drift tests below read this and `app_csp`; see the note there.
#[cfg_attr(not(test), allow(dead_code))]
const ARTIFACT_REQUIRED: [&str; 5] = [
    "connect-src 'none'",
    "img-src data: blob:",
    "form-action 'none'",
    "object-src 'none'",
    "base-uri 'none'",
];

/// The shell's policy, as this crate builds it.
///
/// The shipping copy lives in `tauri.conf.json`, because Tauri reads its CSP at
/// compile time and there is no runtime API to set one. That makes *this*
/// function the pin rather than the source: the test at the bottom of this file
/// fails if the two ever differ, so the JSON cannot be quietly weakened
/// without a red suite. It has no non-test caller by design, which is why the
/// lint suppression is scoped to `not(test)`.
#[cfg_attr(not(test), allow(dead_code))]
#[must_use]
pub fn app_csp() -> String {
    [
        "default-src 'self'",
        // Tauri appends its nonce to the injected script/style tags at runtime.
        "script-src 'self'",
        // Tailwind v4 puts utility rules in a stylesheet the plugin injects,
        // and React sets `style` attributes for dynamic values.
        "style-src 'self' 'unsafe-inline'",
        // ipc: is the Windows IPC scheme; http://ipc.localhost is macOS/Linux.
        "connect-src 'self' ipc: http://ipc.localhost",
        "img-src 'self' data: blob: asset: http://asset.localhost",
        "font-src 'self' data:",
        // The artifact frame is a served document on its own scheme (D123/D124):
        // same sandbox, opaque origin — but a distinct host, named here so the
        // frame is allowed to load. `about:` stays for the initial blank frame.
        "frame-src 'self' about: http://artifact.localhost artifact:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ]
    .join("; ")
}

/// The artifact policy for one render, bound to `nonce`.
///
/// `default-src 'none'` is the whole strategy: nothing is reachable unless a
/// later directive names it. `script-src` is nonce-only, which is why the
/// envelope gives *its own* bootstrap the same nonce as the compiled artifact —
/// both are the host's decision, and neither needs `unsafe-inline`.
#[must_use]
pub fn artifact_csp(nonce: &str) -> String {
    [
        "default-src 'none'".to_string(),
        format!("script-src 'nonce-{nonce}'"),
        // The vendored stylesheet and the artifact's `style` attributes.
        "style-src 'unsafe-inline'".to_string(),
        "img-src data: blob:".to_string(),
        "font-src data:".to_string(),
        "connect-src 'none'".to_string(),
        // A form post is an egress channel with the user's session attached.
        "form-action 'none'".to_string(),
        "object-src 'none'".to_string(),
        // `<base href>` would re-point every relative URL in the document,
        // including the ones the nav guard judges.
        "base-uri 'none'".to_string(),
    ]
    .join("; ")
}

/// True when `policy` names every directive `D3` requires. Read by the tests
/// below, for the same reason as `app_csp`.
#[cfg_attr(not(test), allow(dead_code))]
#[must_use]
pub fn has_required_artifact_directives(policy: &str) -> bool {
    ARTIFACT_REQUIRED
        .iter()
        .all(|directive| policy.split(';').any(|d| d.trim() == *directive))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_policy_names_every_d3_directive() {
        let policy = artifact_csp("n1");
        for directive in ARTIFACT_REQUIRED {
            assert!(
                policy.split(';').any(|d| d.trim() == directive),
                "missing {directive} in {policy}"
            );
        }
        assert!(has_required_artifact_directives(&policy));
    }

    #[test]
    fn neither_policy_contains_a_wildcard_or_unsafe_eval() {
        for policy in [app_csp(), artifact_csp("n1")] {
            assert!(!policy.contains("unsafe-eval"), "{policy}");
            // A bare `*` source would be an egress hole: only `'self'`, a
            // nonce, and scheme words like `data:` are ever allowed.
            assert!(!policy.contains('*'), "wildcard source in {policy}");
        }
    }

    #[test]
    fn the_artifact_policy_has_no_script_escape_hatches() {
        let policy = artifact_csp("n1");
        // `unsafe-inline` on script-src is the whole ballgame; styles may have
        // it, scripts may not.
        let script_src = policy
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("script-src"))
            .expect("script-src present");
        assert!(!script_src.contains("unsafe-inline"), "{script_src}");
        assert!(!script_src.contains("unsafe-eval"), "{script_src}");
        assert_eq!(script_src, "script-src 'nonce-n1'");
    }

    #[test]
    fn the_nonce_is_the_only_thing_that_varies() {
        assert!(artifact_csp("aaa").contains("'nonce-aaa'"));
        assert!(!artifact_csp("aaa").contains("'nonce-bbb'"));
    }

    #[test]
    fn app_policy_still_allows_tauri_ipc_and_the_served_frame() {
        let policy = app_csp();
        assert!(policy.contains("connect-src 'self' ipc:"));
        assert!(policy.contains("frame-src 'self' about:"));
        // The frame's own host, or the sandbox would have nothing to load.
        assert!(policy.contains("http://artifact.localhost"), "{policy}");
        // The shell is not the artifact: it must not inherit `connect-src 'none'`.
        assert!(!policy.contains("connect-src 'none'"));
    }

    /// `tauri.conf.json` is what Tauri actually applies, so the JSON and this
    /// function cannot drift: editing one without the other fails here first.
    #[test]
    fn tauri_conf_matches_the_assembled_app_policy() {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
            .expect("tauri.conf.json readable");
        let conf: serde_json::Value = serde_json::from_str(&raw).expect("tauri.conf.json parses");
        let in_conf = conf
            .pointer("/app/security/csp")
            .and_then(serde_json::Value::as_str)
            .expect("app.security.csp is a string");
        assert_eq!(
            in_conf,
            app_csp(),
            "tauri.conf.json CSP has drifted from csp::app_csp()"
        );
    }
}
