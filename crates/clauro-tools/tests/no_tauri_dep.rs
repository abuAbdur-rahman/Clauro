//! A handler in `clauro-tools` may not import `tauri` (`TECH_STACK.md` §2).
//!
//! Mechanical: same manifest-scanning approach as `clauro-core`'s
//! `no_extra_deps` test. A convention someone breaks quietly is how a host
//! dependency leaks into the tool loop.

fn normal_deps(manifest: &str) -> Vec<String> {
    let mut in_deps = false;
    let mut out = Vec::new();
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_deps = line == "[dependencies]";
            continue;
        }
        if !in_deps || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.split(['=', ' ']).next() {
            let name = name.trim().to_string();
            if !name.is_empty() {
                out.push(name);
            }
        }
    }
    out
}

#[test]
fn tools_must_not_depend_on_tauri() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let manifest = std::fs::read_to_string(format!("{dir}/Cargo.toml"))
        .expect("own manifest must be readable");
    let deps = normal_deps(&manifest);
    assert!(
        !deps.iter().any(|d| d == "tauri" || d == "tauri-build"),
        "clauro-tools must not depend on tauri (found: {deps:?}); \
         only src-tauri knows Tauri exists"
    );
}
