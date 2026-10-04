//! Task 007 — eight descriptions, ours, pinned (RED).
//!
//! All descriptions are written from scratch (D39): two MIT references carry
//! first-party prompt text verbatim, and MIT cannot relicense it. Behaviour
//! borrowed, wording ours. This test pins the exact text — any wording change
//! fails here first, forcing a conscious re-check that the new text is still
//! ours rather than drift toward reference phrasing.

use clauro_tools::Registry;

const EXPECTED: [(&str, &str); 8] = [
    (
        "memory",
        "Keep small durable notes the user asked to remember, scoped to a topic. Reads merge into the reply; writes replace one topic at a time and never store secrets.",
    ),
    (
        "artifact",
        "Render a self-contained document, page, or graphic in the side drawer from a title, media type, and source. Runs with no network and no access to the app.",
    ),
    (
        "web-search",
        "Search the public web and return short cited hits. Pass the current year with the query so time-sensitive questions anchor correctly.",
    ),
    (
        "web-fetch",
        "Read one page into text. Prefer a more targeted tool when one is present; large pages arrive truncated with the remainder addressable.",
    ),
    (
        "fs",
        "Read, list, write, and edit files inside the session workspace only. Paths outside are refused, and edit needs a prior read of the same path.",
    ),
    (
        "compact",
        "Summarise the thread so far into a checkpoint. Host-driven only: it never appears in the request schema and runs from the /compact command.",
    ),
    (
        "bash",
        "Run one shell command after the user approves it, every time, with nothing remembered between runs. Off unless the project opts in.",
    ),
    (
        "question",
        "Ask the user one inline question with options and a skip choice, at most once per turn. Secret-shaped prompts are refused.",
    ),
];

#[test]
fn descriptions_match_word_for_word() {
    let reg = Registry::with_eight();
    for (name, text) in EXPECTED {
        let got = reg.description(name).expect("all eight described");
        assert_eq!(got, text, "wording drift on `{name}` — re-check D39");
    }
}

#[test]
fn descriptions_are_distinct_and_self_naming() {
    let reg = Registry::with_eight();
    let texts: Vec<String> = EXPECTED
        .iter()
        .map(|(name, _)| reg.description(name).expect("described"))
        .collect();
    let mut seen = std::collections::BTreeSet::new();
    for t in &texts {
        assert!(seen.insert(t.clone()), "duplicate blurb: {t}");
        assert!(!t.is_empty());
    }
}
