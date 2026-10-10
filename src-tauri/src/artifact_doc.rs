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
//! branches (not the `tauri` protocol URL, not the app URL, and the scheme is
//! registered at the wry level so Tauri's protocol map never names it), and
//! no capability grants a remote context (pinned by test below) — so every
//! invoke from the frame fails closed at the ACL check, and the fetch path
//! never leaves the frame at all (`connect-src 'none'`).

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

/// The custom scheme the documents are served from (D124). Registered at the
/// wry level in `lib.rs`, never through Tauri's protocol map — that absence
/// is load-bearing: it is what keeps the third `is_local_url` branch false.
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
}

impl std::fmt::Display for DocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocError::BadToken { reason } => write!(f, "bad artifact document token: {reason}"),
            DocError::EmptyDocument => write!(f, "refusing to publish an empty artifact document"),
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
        let mut inner = self.inner.lock().expect("doc registry poisoned");
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
        self.inner
            .lock()
            .expect("doc registry poisoned")
            .docs
            .get(token)
            .cloned()
    }
}

/// The absolute URL the frame navigates to. Built here, not in TypeScript:
/// the correct form of this origin is the platform's, and the platform
/// knowledge belongs to the crate that knows Tauri exists.
pub fn doc_url(token: &str) -> String {
    format!("{ORIGIN}{PATH_PREFIX}{token}")
}

/// Route a document-path request. `None` means "not our route" — the caller
/// falls through to the asset resolver. Any path under the prefix is ours,
/// including malformed ones: those answer 404 rather than serving the shell.
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

/// The static half of the route: byte-for-byte what Tauri's built-in handler
/// answers for an asset — configured headers, the window origin, the asset's
/// mime type and its `csp_header`, which is how the shell keeps its own
/// policy (D78). The tuple is the public `AssetResolver`'s payload, taken
/// field by field so this function stays constructible in tests without
/// naming Tauri's types.
pub fn static_response(
    asset: Option<(Vec<u8>, String, Option<String>)>,
    origin: &str,
) -> Response<Vec<u8>> {
    match asset {
        Some((bytes, mime_type, csp_header)) => {
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime_type)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            if let Some(csp) = csp_header {
                builder = builder.header(header::CONTENT_SECURITY_POLICY, csp);
            }
            builder
                .body(bytes)
                .expect("static asset response headers come from the resolver")
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(b"not found".to_vec())
            .expect("static not-found response headers are literal"),
    }
}

/// One entry point for the whole `artifact` scheme (D123/D124): documents
/// under [`PATH_PREFIX`] answer from the registry — never from the asset
/// resolver's `index.html` fallback — and everything else is delegated to the
/// resolver so an asset read under this scheme behaves exactly as it does
/// under the shell's.
pub fn handle_request(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path();
    if let Some(response) = app
        .try_state::<DocRegistry>()
        .and_then(|registry| doc_route(&registry, path))
    {
        return response;
    }
    let asset = app
        .asset_resolver()
        .get(path.to_string())
        .map(|a| (a.bytes, a.mime_type, a.csp_header));
    static_response(asset, ORIGIN)
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
        // Not under the prefix: not ours.
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

    // ── static delegation: byte-for-byte the built-in handler's contract ──
    // (tauri-2.12.1 protocol/tauri.rs get_response): configured headers, the
    // window origin, the asset's own mime type and — load-bearing — the
    // asset's `csp_header`, which is how the shell keeps ITS policy (D78).

    #[test]
    fn static_response_carries_the_assets_type_policy_and_origin() {
        let body = b"<!doctype html><html></html>".to_vec();
        let res = static_response(
            Some((
                body.clone(),
                "text/html".to_string(),
                Some("default-src 'self'".to_string()),
            )),
            ORIGIN,
        );
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(get(&res, header::CONTENT_TYPE), "text/html");
        assert_eq!(
            get(&res, header::CONTENT_SECURITY_POLICY),
            "default-src 'self'"
        );
        assert_eq!(get(&res, header::ACCESS_CONTROL_ALLOW_ORIGIN), ORIGIN);
        assert_eq!(res.body().as_slice(), body.as_slice());
    }

    #[test]
    fn static_response_omits_the_policy_header_when_the_asset_has_none() {
        let res = static_response(
            Some((b"var x = 1;".to_vec(), "text/javascript".to_string(), None)),
            ORIGIN,
        );
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(get(&res, header::CONTENT_TYPE), "text/javascript");
        assert_eq!(get(&res, header::CONTENT_SECURITY_POLICY), "");
    }

    #[test]
    fn static_response_is_a_404_when_the_asset_is_missing() {
        let res = static_response(None, ORIGIN);
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(res.body().as_slice(), b"not found".as_slice());
    }

    // ── D124: the document host is remote to Tauri's IPC ─────────────────
    // wry injects the host init scripts into every Windows frame (its
    // webview2 backend ignores `for_main_frame_only`), so the frame owns a
    // `__TAURI_INTERNALS__` object. What keeps it inert is the host half:
    // the document URL must match none of `is_local_url`'s three branches,
    // and no capability may grant a remote context — then every invoke from
    // the frame fails closed at `on_message`'s ACL check.

    #[test]
    fn the_document_host_is_never_the_shells() {
        let url = doc_url(NONCE);
        // Branch 1 (`tauri_protocol_url`) and branch 2 (app URL) both resolve
        // to the shell host; branch 3 only knows protocols Tauri itself was
        // asked to register, and this scheme is registered at the wry level.
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
