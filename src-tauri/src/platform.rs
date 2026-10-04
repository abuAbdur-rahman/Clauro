//! Runtime environment probes. Honest reporting about the world outside the
//! app: is the webview runtime present, is there a keychain backend?
//!
//! These return facts, never panics. A missing runtime on a locked-down
//! machine is the expected failure mode of an evergreen bootstrapper (D49) —
//! the product explains it before first paint (D53) instead of showing a blank
//! window or a bare crash.

use serde::Serialize;

/// WebView2/WebKit runtime presence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WebviewStatus {
    /// Runtime present. Carries the resolved version so the floor jobs can
    /// record what was actually tested (TECH_STACK.md §5).
    Present { version: String },
    /// Runtime missing. Carries what the user should do, not a stack trace.
    Missing { hint: String },
}

/// Report the webview runtime version, or its absence, without panicking.
/// `tauri::webview_version` returns `Err` when no runtime is installed.
pub fn webview_status() -> WebviewStatus {
    map_webview_result(tauri::webview_version().map_err(|e| e.to_string()))
}

/// Pure mapping, tested without touching the OS: any version string means
/// present, any error means missing with the hint intact.
pub fn map_webview_result(result: Result<String, String>) -> WebviewStatus {
    match result {
        Ok(version) => WebviewStatus::Present { version },
        Err(_) => WebviewStatus::Missing {
            hint: "The WebView2 runtime is not installed. Install it from \
                   Microsoft and relaunch Clauro — your data is untouched."
                .to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_maps_to_present_with_version() {
        match map_webview_result(Ok("153.0.4234.48".to_string())) {
            WebviewStatus::Present { version } => assert_eq!(version, "153.0.4234.48"),
            WebviewStatus::Missing { .. } => panic!("Ok must map to Present"),
        }
    }

    #[test]
    fn err_maps_to_missing_with_hint() {
        match map_webview_result(Err("no runtime".to_string())) {
            WebviewStatus::Missing { hint } => assert!(!hint.is_empty()),
            WebviewStatus::Present { .. } => panic!("Err must map to Missing"),
        }
    }

    #[test]
    fn local_webview_check_runs_headless() {
        // On this Windows dev host the runtime exists; on a bare box it does
        // not. Either way the call returns a fact — it never panics and never
        // needs a window.
        let _ = webview_status();
    }
}
