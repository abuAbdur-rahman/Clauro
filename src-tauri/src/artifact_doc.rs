//! Artifact document serving (D123, D124).
//!
//! `srcdoc` was transport, but a `srcdoc` document inherits the shell's
//! response-header CSP (HTML: the policy container comes from the parent for
//! `about:srcdoc`), and the shell's `script-src 'self'` never allows an inline
//! script — so no artifact script could execute under it. The proof harness
//! showed exactly that: three `script-src-elem` violations, one for a
//! nonce-carrying clone the frame's own meta policy accepts.
//!
//! The transport is now a document served from a dedicated `artifact` scheme
//! through the public `Builder::register_uri_scheme_protocol(…)` hook. The
//! response carries `artifact_csp(nonce)` as a **header**, so the document has
//! exactly one policy — the one Rust assembles (D3) — and the sandbox
//! attribute remains the sole boundary (D2/D123).
//!
//! The scheme is deliberately NOT the shell's (D124): wry's WebView2 backend
//! injects the host init scripts into every frame — it ignores
//! `for_main_frame_only` — so the frame owns a `__TAURI_INTERNALS__` object.
//! What keeps it inert is the host half. A document at
//! `http://artifact.localhost/…` matches none of `is_local_url`'s three
//! branches (tauri-2.12.1 `webview/mod.rs:1961-2002`): not branch 1, whose
//! domain is `tauri.localhost`; not branch 2, the app URL; and not branch 3,
//! whose Windows arm compares the URL's scheme against the **tauri asset
//! protocol's** scheme — `"http" == "tauri"` is false whatever the protocol
//! map holds, so registering `artifact` here does not make the frame local.
//! The message therefore arrives as `Origin::Remote`, and no capability
//! grants a remote context (pinned by test below) — so every invoke from the
//! frame fails closed at the ACL check, and the fetch path never leaves the
//! frame at all (`connect-src 'none'`). Empirically pinned by
//! `scripts/webview-proofs.mjs` claim 1 (sentinel-effect probe): the frame's
//! invoke hangs dead-lettered while the shell's own IPC stays healthy.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde::Serialize;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::Manager;

use crate::csp;

/// Where published documents are served. Any path under this prefix is ours:
/// it never falls through to the asset resolver, so a malformed token is a 404
/// and never the shell's `index.html` rendered inside the frame.
pub const PATH_PREFIX: &str = "/__clauro/doc/";

/// The custom scheme the documents are served from (D124). Registered in
/// `lib.rs` through Tauri's public `register_uri_scheme_protocol` hook, which
/// does add it to Tauri's protocol map — what keeps the third `is_local_url`
/// branch false is that branch's Windows arm comparing the URL's scheme
/// against the tauri *asset* protocol's scheme (`http` ≠ `tauri`), not the
/// map's contents. See the module doc for the full mechanism.
pub const SCHEME: &str = "artifact";

/// The document origin as the webview resolves it. wry maps a custom scheme
/// onto `http://<scheme>.localhost` on Windows (and `<scheme>://localhost`
/// elsewhere); Windows is the verified floor (§8a). This must never equal the
/// shell's origin: a document on the shell's host would read as local to
/// Tauri's IPC, and the frame's injected internals would stop being inert.
const ORIGIN: &str = if cfg!(windows) {
    "http://artifact.localhost"
} else {
    "artifact://localhost"
};

/// How many published documents stay resident. A re-render republishes, so
/// eviction only drops documents nothing is looking at any more; the cap
/// keeps the map bounded no matter how many turns run (D27's spirit: bounded
/// on the way out).
const CAPACITY: usize = 96;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum DocError {
    /// The nonce doubles as the path token; an empty or non-path-safe one
    /// would either be unmatchable or able to escape the prefix.
    BadToken { reason: String },
    /// An empty document would render as a blank frame — the bug the drawer
    /// exists to prevent.
    EmptyDocument,
    /// A poisoned registry mutex means an earlier publish panicked while
    /// holding the lock. A typed refusal beats panicking inside a Tauri
    /// command; the caller sees a failed publish, not a dead shell.
    Registry { reason: String },
}

impl std::fmt::Display for DocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocError::BadToken { reason } => write!(f, "bad artifact document token: {reason}"),
            DocError::EmptyDocument => write!(f, "refusing to publish an empty artifact document"),
            DocError::Registry { reason } => write!(f, "artifact registry unavailable: {reason}"),
        }
    }
}

/// A document waiting to be loaded, with the policy it was built for. The
/// nonce is stored because the header must name the same value the envelope's
/// tags carry (D110) — one render, one nonce, two deliveries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedDoc {
    pub nonce: String,
    pub html: Vec<u8>,
}

#[derive(Default)]
pub struct DocRegistry {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    docs: HashMap<String, PublishedDoc>,
    order: VecDeque<String>,
}

/// The token must survive a URL path unchanged: letters, digits, `-`, `_`.
fn token_is_path_safe(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 128
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `nonce` doubles as the token: it is already CSPRNG output, already unique
/// per render, and already known to the document being served.
impl DocRegistry {
    pub fn publish(&self, nonce: &str, html: &str) -> Result<String, DocError> {
        if !token_is_path_safe(nonce) {
            return Err(DocError::BadToken {
                reason: "must be 1..=128 chars of [A-Za-z0-9_-]".to_string(),
            });
        }
        if html.trim().is_empty() {
            return Err(DocError::EmptyDocument);
        }
        let mut inner = self.inner.lock().map_err(|_| DocError::Registry {
            reason: "the document registry lock is poisoned".to_string(),
        })?;
        if !inner.docs.contains_key(nonce) {
            inner.order.push_back(nonce.to_string());
        }
        inner.docs.insert(
            nonce.to_string(),
            PublishedDoc {
                nonce: nonce.to_string(),
                html: html.as_bytes().to_vec(),
            },
        );
        while inner.order.len() > CAPACITY {
            if let Some(oldest) = inner.order.pop_front() {
                inner.docs.remove(&oldest);
            } else {
                break;
            }
        }
        Ok(doc_url(nonce))
    }

    pub fn resolve(&self, token: &str) -> Option<PublishedDoc> {
        // A poisoned lock means an earlier holder panicked; resolving
        // nothing (→ 404) fails closed instead of panicking the handler.
        self.inner.lock().ok()?.docs.get(token).cloned()
    }
}

/// The absolute URL the frame navigates to. Built here, not in TypeScript:
/// the correct form of this origin is the platform's, and the platform
/// knowledge belongs to the crate that knows Tauri exists.
pub fn doc_url(token: &str) -> String {
    format!("{ORIGIN}{PATH_PREFIX}{token}")
}

/// Route a document-path request. `None` means "not under the prefix" — the
/// caller answers 404, never the shell bundle. Any path under the prefix is
/// ours, including malformed ones: those answer 404 rather than serving the
/// shell.
pub fn doc_route(registry: &DocRegistry, path: &str) -> Option<Response<Vec<u8>>> {
    let rest = path.strip_prefix(PATH_PREFIX)?;
    Some(match registry.resolve(rest) {
        Some(doc) => doc_response(&doc),
        None => not_found_response(),
    })
}

/// The document response: one policy, delivered the only way an http document
/// can carry one reliably — a header, before any content parses (D3, D123).
fn doc_response(doc: &PublishedDoc) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(
            header::CONTENT_SECURITY_POLICY,
            csp::artifact_csp(&doc.nonce),
        )
        // The URL carries the nonce; nothing that leaves the app should echo it.
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, ORIGIN)
        .body(doc.html.clone())
        .expect("static document response headers are literal")
}

fn not_found_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(b"not found".to_vec())
        .expect("static not-found response headers are literal")
}

/// One entry point for the whole `artifact` scheme (D123/D124): documents
/// under [`PATH_PREFIX`] answer from the registry, and **everything else is a
/// 404** — the shell bundle is never served under this scheme. The previous
/// handler delegated unknown paths to Tauri's asset resolver, which proxied
/// the shell's `index.html` (with the shell's own CSP) into the artifact
/// origin; self-navigation (D90) made that reachable from artifact script.
/// The registry being absent mid-setup fails closed the same way.
pub fn route(registry: Option<&DocRegistry>, path: &str) -> Response<Vec<u8>> {
    match registry.and_then(|registry| doc_route(registry, path)) {
        Some(response) => response,
        None => not_found_response(),
    }
}

/// The scheme handler: the registry state plus the request path, nothing
/// else. No asset resolver, no fall-through.
pub fn handle_request(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    route(
        app.try_state::<DocRegistry>().as_deref(),
        request.uri().path(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "b5368753043e790e75991b0b17c027af";

    fn get(res: &Response<Vec<u8>>, name: header::HeaderName) -> String {
        res.headers()
            .get(name)
            .map(|v| v.to_str().unwrap_or("").to_string())
            .unwrap_or_default()
    }

    #[test]
    fn publish_returns_the_absolute_document_url() {
        let registry = DocRegistry::default();
        let url = registry
            .publish(NONCE, "<!doctype html><p>hi</p>")
            .expect("publish");
        assert_eq!(url, format!("{ORIGIN}{PATH_PREFIX}{NONCE}"));
        // Remote by construction (D124): the document host must never be the
        // shell's, or Tauri's IPC would treat the frame as local.
        assert!(url.starts_with("http://artifact.localhost/__clauro/doc/"));
        assert!(!url.contains("tauri.localhost"));
    }

    #[test]
    fn publish_refuses_tokens_that_could_leave_the_prefix() {
        let registry = DocRegistry::default();
        for bad in [
            "",
            "../etc/passwd",
            "a/b",
            "a b",
            "a?b",
            "x".repeat(129).as_str(),
        ] {
            let err = registry.publish(bad, "<p>x</p>").expect_err("must refuse");
            assert!(
                matches!(err, DocError::BadToken { .. }),
                "expected BadToken for {bad:?}, got {err:?}"
            );
        }
        assert!(registry.resolve("../etc/passwd").is_none());
    }

    #[test]
    fn publish_refuses_an_empty_document() {
        let registry = DocRegistry::default();
        assert_eq!(
            registry.publish(NONCE, "   \n "),
            Err(DocError::EmptyDocument)
        );
    }

    /// A poisoned mutex means an earlier holder panicked mid-publish. The
    /// command boundary must see a typed refusal, never a panic (D55: nothing
    /// throws across the tool boundary).
    #[test]
    fn a_poisoned_registry_fails_typed_not_with_a_panic() {
        let registry = DocRegistry::default();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = registry.inner.lock().unwrap();
            panic!("simulated holder panic");
        }));
        assert!(panicked.is_err(), "the poisoning step must panic");
        assert!(registry.inner.is_poisoned());
        let err = registry
            .publish(NONCE, "<p>x</p>")
            .expect_err("a poisoned registry must refuse");
        assert!(matches!(err, DocError::Registry { .. }), "{err:?}");
        assert!(
            registry.resolve(NONCE).is_none(),
            "a poisoned registry resolves nothing"
        );
    }

    #[test]
    fn the_document_response_carries_one_header_policy_and_the_body() {
        let registry = DocRegistry::default();
        let html = "<!doctype html><h1>Artifact proof</h1>";
        registry.publish(NONCE, html).expect("publish");
        let res = doc_route(&registry, &format!("{PATH_PREFIX}{NONCE}")).expect("route");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(get(&res, header::CONTENT_TYPE), "text/html; charset=utf-8");
        assert_eq!(
            get(&res, header::CONTENT_SECURITY_POLICY),
            csp::artifact_csp(NONCE)
        );
        assert_eq!(get(&res, header::REFERRER_POLICY), "no-referrer");
        assert_eq!(res.body().as_slice(), html.as_bytes());
    }

    #[test]
    fn the_header_policy_is_the_artifact_one_never_the_shells() {
        let registry = DocRegistry::default();
        registry.publish(NONCE, "<p>x</p>").expect("publish");
        let res = doc_route(&registry, &format!("{PATH_PREFIX}{NONCE}")).expect("route");
        let policy = get(&res, header::CONTENT_SECURITY_POLICY);
        assert!(policy.contains("script-src 'nonce-"), "{policy}");
        assert!(policy.contains("connect-src 'none'"), "{policy}");
        // The shell policy would reintroduce the intersection that killed the
        // frame's scripts (D123's whole reason): it must never appear here.
        assert!(!policy.contains("connect-src 'self'"), "{policy}");
        assert!(!policy.contains("script-src 'self'"), "{policy}");
    }

    #[test]
    fn an_unknown_or_malformed_token_is_a_404_not_the_shell() {
        let registry = DocRegistry::default();
        // Under the prefix: ours, even when malformed — never the asset
        // resolver's index.html fallback rendered as an artifact.
        for path in [
            format!("{PATH_PREFIX}missing"),
            format!("{PATH_PREFIX}../../index.html"),
            PATH_PREFIX.to_string(),
        ] {
            let res = doc_route(&registry, &path).expect("route");
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(get(&res, header::CONTENT_SECURITY_POLICY), "", "{path}");
        }
        // Not under the prefix: not `doc_route`'s — and `route` answers 404
        // for exactly those (pinned by the shell-bundle test above).
        assert!(doc_route(&registry, "/index.html").is_none());
        assert!(doc_route(&registry, "/assets/main.js").is_none());
        assert!(doc_route(&registry, "/").is_none());
    }

    #[test]
    fn the_registry_evicts_oldest_beyond_capacity() {
        let registry = DocRegistry::default();
        for i in 0..CAPACITY + 3 {
            let nonce = format!("nonce-{i:04}");
            registry.publish(&nonce, "<p>x</p>").expect("publish");
        }
        assert!(
            registry.resolve("nonce-0000").is_none(),
            "oldest must be evicted"
        );
        assert!(registry.resolve("nonce-0001").is_none(), "eviction is FIFO");
        let newest = format!("nonce-{:04}", CAPACITY + 2);
        assert!(registry.resolve(&newest).is_some(), "newest stays");
    }

    #[test]
    fn republished_token_does_not_duplicate_the_order() {
        let registry = DocRegistry::default();
        registry.publish(NONCE, "<p>one</p>").expect("publish");
        registry.publish(NONCE, "<p>two</p>").expect("republish");
        let res = doc_route(&registry, &format!("{PATH_PREFIX}{NONCE}")).expect("route");
        assert_eq!(res.body().as_slice(), b"<p>two</p>");
        // order holds exactly one entry for the token, so capacity maths holds.
        assert_eq!(registry.inner.lock().unwrap().order.len(), 1);
    }

    // ── the scheme serves exactly the registry, nothing else ──────────────
    // The old handler delegated unknown paths to Tauri's asset resolver, so
    // `http://artifact.localhost/index.html` answered with the SHELL's HTML
    // under the shell's CSP (review 13, item 2). Production frontend code
    // under the artifact origin is the exact thing D124 exists to prevent —
    // `route` is the fall-through removed, pinned from every angle.

    #[test]
    fn nothing_outside_the_doc_prefix_is_served_never_the_shell_bundle() {
        let registry = DocRegistry::default();
        registry.publish(NONCE, "<p>x</p>").expect("publish");
        for path in [
            "/",
            "/index.html",
            "/assets/main.js",
            "/__clauro/",
            "/__clauro/index.html",
        ] {
            let res = route(Some(&registry), path);
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(res.body().as_slice(), b"not found", "{path}");
            assert_eq!(
                get(&res, header::CONTENT_SECURITY_POLICY),
                "",
                "{path} must not carry any policy — it carries no content"
            );
        }
        // The document itself still serves.
        let ok = route(Some(&registry), &format!("{PATH_PREFIX}{NONCE}"));
        assert_eq!(ok.status(), StatusCode::OK);
    }

    #[test]
    fn no_registry_means_nothing_is_served() {
        // Mid-setup the state is absent; a document path must 404 rather
        // than reach any resolver (fail closed, no fall-through).
        let res = route(None, &format!("{PATH_PREFIX}{NONCE}"));
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(res.body().as_slice(), b"not found");
    }

    // ── D124: the document host is remote to Tauri's IPC ─────────────────
    // wry injects the host init scripts into every Windows frame (its
    // webview2 backend ignores `for_main_frame_only`), so the frame owns a
    // `__TAURI_INTERNALS__` object. What keeps it inert is the host half:
    // the document URL must match none of `is_local_url`'s three branches,
    // and no capability may grant a remote context — then every invoke from
    // the frame fails closed at `on_message`'s ACL check. Pinned empirically
    // by `scripts/webview-proofs.mjs` claim 1 (sentinel-effect probe,
    // 2026-10-12: no effect from the frame while the shell's IPC is healthy).

    #[test]
    fn the_document_host_is_never_the_shells() {
        let url = doc_url(NONCE);
        // Branch 1 (`tauri_protocol_url`, domain `tauri.localhost`) and
        // branch 2 (app URL) both resolve to the shell host; branch 3's
        // Windows arm compares the URL's scheme against the tauri ASSET
        // protocol's scheme — `http` != `tauri` — so the frame is Remote
        // whatever the protocol map holds. On non-Windows floors branch 3 is
        // `contains_key("artifact")` instead, which WOULD match: that path
        // is recorded in review 13 as unverified beyond the Windows floor.
        assert!(!url.contains("tauri.localhost"), "{url}");
        assert!(!url.contains("localhost:1420"), "{url}");
        assert_eq!(
            url,
            format!("http://artifact.localhost/__clauro/doc/{NONCE}"),
            "remote by construction on the verified floor (§8a)"
        );
    }

    /// The second half of the closure argument: Tauri rejects remote invokes
    /// unless a capability explicitly grants a `remote` context, so the repo
    /// must contain no such grant. Any future `remote` capability has to
    /// revisit D124 first — this test fails until it does.
    #[test]
    fn no_capability_grants_a_remote_context() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut files = vec![root.join("tauri.conf.json")];
        let caps = root.join("capabilities");
        if caps.is_dir() {
            let mut dirs = vec![caps];
            while let Some(dir) = dirs.pop() {
                for entry in std::fs::read_dir(&dir).expect("capabilities dir") {
                    let path = entry.expect("dir entry").path();
                    if path.is_dir() {
                        dirs.push(path);
                    } else if path.extension().is_some_and(|e| e == "json") {
                        files.push(path);
                    }
                }
            }
        }
        assert!(!files.is_empty(), "expected at least tauri.conf.json");
        for path in &files {
            let text = std::fs::read_to_string(path).expect("readable capability file");
            let value: serde_json::Value =
                serde_json::from_str(&text).expect("capability files stay valid JSON");
            assert!(
                !json_has_key(&value, "remote"),
                "{} must not grant a remote context (D124)",
                path.display()
            );
        }
    }

    fn json_has_key(value: &serde_json::Value, key: &str) -> bool {
        match value {
            serde_json::Value::Object(map) => {
                map.keys().any(|k| k == key) || map.values().any(|v| json_has_key(v, key))
            }
            serde_json::Value::Array(items) => items.iter().any(|v| json_has_key(v, key)),
            _ => false,
        }
    }
}
