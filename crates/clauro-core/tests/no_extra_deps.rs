//! `clauro-core` depends on nothing but `serde` (`TECH_STACK.md` §2).
//!
//! Mechanical, not conventional: this test reads the crate's own manifest at
//! `CARGO_MANIFEST_DIR` and asserts on the dependency sections. Zero new
//! dependencies to do it — a string scan is honest about what it checks.
//!
//! Scope notes:
//! - In-deps means `[dependencies]`, a dotted `[dependencies.x]` subtable,
//!   and a `[target.'…'.dependencies]` table — every form that ships in the
//!   built artifact. `[dev-dependencies]` and `[build-dependencies]` are
//!   test/build tooling, not the shipped graph.
//! - `serde` with any features is still `serde`.

use std::collections::BTreeSet;

/// Names in `[dependencies]`, excluding section headers and comments.
fn normal_deps(manifest: &str) -> BTreeSet<String> {
    let mut in_deps = false;
    let mut out = BTreeSet::new();
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            // A dependency section is `[dependencies]`, a dotted subtable
            // `[dependencies.x]`, or a target table ending in
            // `.dependencies]` — all three ship. Every other section —
            // including `[dev-dependencies]` and `[build-dependencies]` —
            // closes it. Dev/build sections never end in `.dependencies]`
            // (no dot before the name), so the rule cannot misfire on them.
            in_deps = line == "[dependencies]"
                || line.starts_with("[dependencies.")
                || line.ends_with(".dependencies]");
            continue;
        }
        if !in_deps || line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.split(['=', ' ']).next() {
            let name = name.trim();
            if !name.is_empty() {
                out.insert(name.to_string());
            }
        }
    }
    out
}

#[test]
fn core_depends_on_nothing_but_serde() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let manifest = std::fs::read_to_string(format!("{dir}/Cargo.toml"))
        .expect("own manifest must be readable");
    let deps = normal_deps(&manifest);
    assert_eq!(
        deps,
        BTreeSet::from(["serde".to_string()]),
        "clauro-core [dependencies] must be exactly {{serde}}; the type layer \
         stays free of I/O, and every later headless-test promise rests on it"
    );
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn parser_ignores_dev_and_build_sections() {
        let manifest = "[dependencies]\nserde = \"1\"\n\n[dev-dependencies]\ntoml = \"1\"\n\n[build-dependencies]\ncc = \"1\"\n";
        assert_eq!(normal_deps(manifest), BTreeSet::from(["serde".to_string()]));
    }

    #[test]
    fn parser_sees_a_violation() {
        let manifest = "[dependencies]\nserde = \"1\"\nreqwest = \"0.13\"\n";
        let deps = normal_deps(manifest);
        assert!(deps.contains("reqwest"));
        assert_ne!(deps, BTreeSet::from(["serde".to_string()]));
    }

    #[test]
    fn parser_sees_a_violation_in_a_dotted_subtable() {
        // `[dependencies.reqwest]` is a dependency table, not a section
        // break: a dep declared there still ships.
        let manifest =
            "[dependencies]\nserde = \"1\"\n\n[dependencies.reqwest]\nreqwest = \"0.13\"\n";
        let deps = normal_deps(manifest);
        assert!(
            deps.contains("reqwest"),
            "a dotted dependency table is in-deps: {deps:?}"
        );
        assert_ne!(deps, BTreeSet::from(["serde".to_string()]));
    }

    #[test]
    fn parser_sees_a_violation_in_a_target_dependencies_table() {
        // `[target.'cfg(windows)'.dependencies]` ships on its target and is
        // exactly the shape that hid a dependency from the scan.
        let manifest =
            "[dependencies]\nserde = \"1\"\n\n[target.'cfg(windows)'.dependencies]\nwinapi = \"0.3\"\n";
        let deps = normal_deps(manifest);
        assert!(
            deps.contains("winapi"),
            "a target dependencies table is in-deps: {deps:?}"
        );
    }

    #[test]
    fn parser_still_excludes_dev_and_build_subtables() {
        let manifest = "[dependencies]\nserde = \"1\"\n\n[dev-dependencies]\ntoml = \"1\"\n\n[build-dependencies]\ncc = \"1\"\n\n[dev-dependencies.extra]\nextra = \"1\"\n";
        assert_eq!(normal_deps(manifest), BTreeSet::from(["serde".to_string()]));
    }
}
