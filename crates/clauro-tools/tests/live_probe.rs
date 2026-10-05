//! Live provider probe — `#[ignore]`d, never runs in CI (no test may require
//! a network). Run by hand with `cargo test -p clauro-tools --test
//! live_probe -- --ignored` to verify the prod getter and the DDG anchor
//! scan against reality. If DDG changes shape, the anchor test fails here
//! first, visibly, instead of rotting silently.

use clauro_tools::{reqwest_getter, HttpRequest};

fn get(url: &str) -> clauro_tools::HttpResponse {
    let getter = reqwest_getter();
    getter(&HttpRequest {
        url: url.to_string(),
        headers: vec![],
        body: None,
    })
    .expect("live request must succeed")
}

#[ignore]
#[test]
fn live_fetch_example_com_converts() {
    let res = get("https://example.com/");
    assert_eq!(res.status, 200);
    let text = String::from_utf8_lossy(&res.body_bytes);
    assert!(text.contains("Example Domain"), "shape drift?");
}

#[ignore]
#[test]
fn live_ddg_anchors_parse() {
    let res = get("https://html.duckduckgo.com/html/?q=rust+programming+language");
    assert_eq!(res.status, 200);
    let text = String::from_utf8_lossy(&res.body_bytes);
    assert!(
        text.contains("uddg=") || text.contains("rust"),
        "DDG shape drift: no outlinks found"
    );
}
