//! Task 007 — output bounding on the way out (RED).
//!
//! Full output is stored whole; the transcript gets a bounded preview plus a
//! path the model can re-read (D27). Nothing is truncated at write time and
//! nothing is lost — truncation at write time loses data permanently.

use clauro_tools::bound_output;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn scratch() -> std::path::PathBuf {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("clauro-007-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch must create");
    dir
}

#[test]
fn five_megabytes_store_whole_preview_bounded_reread_identical() {
    let dir = scratch();
    let full = "x".repeat(5 * 1024 * 1024);
    let bounded = bound_output(&dir, "call-big", &full).expect("bound must succeed");
    let stored = std::fs::read(&bounded.full_path).expect("full must read");
    assert_eq!(stored.len(), full.len(), "all of it, not a slice");
    assert_eq!(stored, full.as_bytes());
    assert!(
        bounded.preview.len() < full.len(),
        "preview is bounded, the file is not"
    );
    let reread = std::fs::read_to_string(&bounded.preview_path).expect("preview must read");
    assert_eq!(
        reread, bounded.preview,
        "previewPath re-reads byte-identical"
    );
    assert!(
        reread.len() <= 8 * 1024 + 4,
        "cap respected: {}",
        reread.len()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn preview_cuts_on_char_boundaries() {
    let dir = scratch();
    // Multibyte tail straddling the cut: must not split a codepoint.
    let full = format!("{}{}", "y".repeat(9000), "héllo");
    let bounded = bound_output(&dir, "call-uni", &full).expect("bound must succeed");
    assert!(bounded.preview.is_char_boundary(bounded.preview.len()));
    assert!(
        "héllo".starts_with(bounded.preview.chars().last().unwrap_or('?'))
            || bounded.preview.len() <= 8200
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn small_output_passes_through_whole() {
    let dir = scratch();
    let bounded = bound_output(&dir, "call-small", "hi").expect("bound must succeed");
    assert_eq!(bounded.preview, "hi");
    let _ = std::fs::remove_dir_all(&dir);
}
