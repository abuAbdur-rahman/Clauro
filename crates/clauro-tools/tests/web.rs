//! Task 011 — search steers, fetch degrades honestly (RED).
//!
//! Year asserted on the wire body, not a comment. Failures are typed results.
//! HTML becomes markdown with scripts/styles gone. Redirects bounded, oversize
//! disclosed. HTTP runs through an injected getter: fakes here, reqwest
//! blocking in prod. No network in `cargo test`, ever.

use clauro_core::{ToolContext, ToolOutcome};
use clauro_tools::{
    current_year, register_web, FetchConfig, HttpRequest, HttpResponse, IncomingCall, Registry,
    SearchConfig, WebHost,
};
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn ctx() -> ToolContext {
    ToolContext {
        thread_id: "t1".to_string(),
        call_id: "c1".to_string(),
        workspace_dir: PathBuf::from("/tmp/ws"),
    }
}

type Handler =
    Arc<dyn Fn(&HttpRequest) -> Result<HttpResponse, clauro_tools::HttpError> + Send + Sync>;

fn host_with(get: Handler) -> (Registry, u64) {
    let host = Arc::new(WebHost {
        search: SearchConfig {
            endpoint: "https://search.test/html".to_string(),
            api_key: None,
        },
        fetch: FetchConfig {
            max_bytes: 1024,
            max_redirects: 3,
        },
        get,
    });
    let mut reg = Registry::with_eight();
    register_web(&mut reg, host);
    let epoch = reg.materialize().epoch;
    (reg, epoch)
}

fn call(reg: &Registry, epoch: u64, tool: &str, input: serde_json::Value) -> ToolOutcome {
    reg.dispatch(
        &IncomingCall {
            name: tool.to_string(),
            input,
            epoch,
        },
        &ctx(),
    )
}

fn ok_text(out: ToolOutcome) -> String {
    match out {
        ToolOutcome::Ok { preview, .. } => preview,
        other => panic!("expected ok, got: {other:?}"),
    }
}

fn fake_ok(body: &'static str) -> Handler {
    Arc::new(move |_| {
        Ok(HttpResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body_bytes: body.as_bytes().to_vec(),
        })
    })
}

// ── search ───────────────────────────────────────────────────────────────────

#[test]
fn year_present_in_wire_body() {
    let seen: Arc<Mutex<Vec<HttpRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let seen_in = seen.clone();
    let get: Handler = Arc::new(move |req| {
        seen_in.lock().expect("lock").push(HttpRequest {
            url: req.url.clone(),
            headers: req.headers.clone(),
            body: req.body.clone(),
        });
        Ok(HttpResponse {
            status: 200,
            headers: vec![],
            body_bytes: br#"{"results": []}"#.to_vec(),
        })
    });
    let (reg, epoch) = host_with(get);
    let _ = call(
        &reg,
        epoch,
        "web-search",
        json!({"query": "rust http client"}),
    );
    let reqs = seen.lock().expect("lock");
    assert_eq!(reqs.len(), 1);
    let year = current_year().to_string();
    assert!(
        reqs[0].url.contains(&year),
        "year on the wire, not in a comment: {}",
        reqs[0].url
    );
    assert!(reqs[0].url.contains("rust"));
}

#[test]
fn json_results_render_as_cited_hits() {
    let (reg, epoch) = host_with(fake_ok(
        r#"{"results": [{"title": "T", "url": "https://t.example/x", "snippet": "S"}]}"#,
    ));
    let text = ok_text(call(&reg, epoch, "web-search", json!({"query": "q"})));
    assert!(text.contains("https://t.example/x"), "{text}");
    assert!(text.contains('T'));
}

#[test]
fn search_failure_is_typed() {
    let get: Handler = Arc::new(|_| Err(clauro_tools::HttpError::Transport("dns".to_string())));
    let (reg, epoch) = host_with(get);
    let out = call(&reg, epoch, "web-search", json!({"query": "q"}));
    assert!(matches!(out, ToolOutcome::Error { .. }), "{out:?}");
}

// ── fetch ────────────────────────────────────────────────────────────────────

const PAGE: &str = r#"<html><head><title>Hi</title><style>.x{color:red}</style>
<script>alert(1)</script></head><body><h1>Hi</h1><p>Body text here.</p></body></html>"#;

#[test]
fn html_becomes_markdown_without_scripts_or_styles() {
    let get: Handler = Arc::new(|_| {
        Ok(HttpResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "text/html".to_string())],
            body_bytes: PAGE.as_bytes().to_vec(),
        })
    });
    let (reg, epoch) = host_with(get);
    let text = ok_text(call(
        &reg,
        epoch,
        "web-fetch",
        json!({"url": "https://x.example/"}),
    ));
    assert!(text.contains("Body text here"), "{text}");
    assert!(!text.contains("alert(1)"), "scripts stripped: {text}");
    assert!(!text.contains("color:red"), "styles stripped: {text}");
}

#[test]
fn redirect_loop_terminates_typed() {
    let get: Handler = Arc::new(|req: &HttpRequest| {
        let next = if req.url.ends_with("/a") { "/b" } else { "/a" };
        Ok(HttpResponse {
            status: 302,
            headers: vec![("location".to_string(), next.to_string())],
            body_bytes: vec![],
        })
    });
    let (reg, epoch) = host_with(get);
    let out = call(
        &reg,
        epoch,
        "web-fetch",
        json!({"url": "https://x.example/a"}),
    );
    match out {
        ToolOutcome::Error { message } => assert!(
            message.contains("redirect"),
            "bounded hops named: {message}"
        ),
        other => panic!("loop must terminate typed: {other:?}"),
    }
}

#[test]
fn oversize_truncated_and_disclosed() {
    let big = "w".repeat(10_000);
    let get: Handler = Arc::new(move |_| {
        Ok(HttpResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body_bytes: big.as_bytes().to_vec(),
        })
    });
    let (reg, epoch) = host_with(get);
    let text = ok_text(call(
        &reg,
        epoch,
        "web-fetch",
        json!({"url": "https://x.example/big"}),
    ));
    assert!(
        text.len() <= 1024 + 200,
        "capped at max_bytes: {}",
        text.len()
    );
    assert!(text.contains("truncated"), "disclosed, not silent: {text}");
}

#[test]
fn fetch_failure_and_bad_scheme_are_typed() {
    let get: Handler = Arc::new(|_| {
        Err(clauro_tools::HttpError::Transport(
            "conn refused".to_string(),
        ))
    });
    let (reg, epoch) = host_with(get);
    let out = call(
        &reg,
        epoch,
        "web-fetch",
        json!({"url": "https://x.example/"}),
    );
    assert!(matches!(out, ToolOutcome::Error { .. }), "{out:?}");
    let out = call(
        &reg,
        epoch,
        "web-fetch",
        json!({"url": "file:///etc/passwd"}),
    );
    assert!(
        matches!(out, ToolOutcome::Error { .. }),
        "no file scheme: {out:?}"
    );
}

#[test]
fn ddg_style_anchors_parse_to_hits() {
    // Synthetic DDG-shaped snippet: the anchor-scan assumption pinned so
    // provider drift fails here first, visibly, instead of rendering nothing.
    let html = r#"<div><a rel="nofollow" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Frust%2Eexample%2Fbook">Rust Book</a></div>"#;
    let get: Handler = Arc::new(move |_| {
        Ok(HttpResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "text/html".to_string())],
            body_bytes: html.as_bytes().to_vec(),
        })
    });
    let (reg, epoch) = host_with(get);
    let text = ok_text(call(
        &reg,
        epoch,
        "web-search",
        json!({"query": "rust book"}),
    ));
    assert!(text.contains("https://rust.example/book"), "{text}");
    assert!(text.contains("Rust Book"), "{text}");
}

#[test]
fn empty_results_are_a_typed_error() {
    let get: Handler = Arc::new(|_| {
        Ok(HttpResponse {
            status: 200,
            headers: vec![("content-type".to_string(), "text/html".to_string())],
            body_bytes: b"<html><body>No anchors here.</body></html>".to_vec(),
        })
    });
    let (reg, epoch) = host_with(get);
    let out = call(&reg, epoch, "web-search", json!({"query": "q"}));
    assert!(matches!(out, ToolOutcome::Error { .. }), "{out:?}");
}
