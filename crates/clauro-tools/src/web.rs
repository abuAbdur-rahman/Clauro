//! `web-search` and `web-fetch`: the two cheapest tools (D48, D56).
//!
//! Behaviour ported, wording original. Search steers with the current year on
//! the wire — a stale year is the single most common failure. Fetch tells the
//! model when *not* to use it (prefer a better-targeted present tool) rather
//! than merely describing itself. Neither writes to disk.
//!
//! HTTP runs through an injected getter: fakes in tests, reqwest blocking in
//! prod. No network in `cargo test`, ever. The default search endpoint is
//! DuckDuckGo's html endpoint with an optional key header; the endpoint is
//! configurable because providers vary and the choice is revisitable.

use crate::registry::Registry;
use clauro_core::{ToolContext, ToolOutcome};
use serde_json::Value;
use std::fmt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Raw fetch cap, in bytes. Over it: truncate and disclose, never silently.
pub const FETCH_DEFAULT_MAX_BYTES: usize = 1_000_000;
/// Redirect hops before the loop verdict.
pub const FETCH_DEFAULT_MAX_REDIRECTS: u32 = 5;
/// Render width for HTML conversion.
const HTML_WIDTH: usize = 100;

/// The endpoint query this run must contain, for the year test.
pub const DDG_HTML_ENDPOINT: &str = "https://html.duckduckgo.com/html/";

/// One HTTP exchange, transport-agnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// Transport-agnostic response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_bytes: Vec<u8>,
}

/// Why HTTP failed. Every variant becomes a typed `error` outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    Transport(String),
    TooManyRedirects(String),
    NoResults,
    UnsupportedType(String),
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(m) => write!(f, "request failed: {m}"),
            Self::TooManyRedirects(m) => write!(f, "redirect loop, bounded hops: {m}"),
            Self::NoResults => f.write_str("no results parsed"),
            Self::UnsupportedType(t) => write!(f, "unsupported content type: {t}"),
        }
    }
}

impl std::error::Error for HttpError {}

/// Injectable HTTP. Fakes in tests; [`reqwest_getter`] in prod.
pub type Getter = Arc<dyn Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync>;

/// Search backend configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchConfig {
    pub endpoint: String,
    pub api_key: Option<String>,
}

/// Fetch limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchConfig {
    pub max_bytes: usize,
    pub max_redirects: u32,
}

/// Session-scoped web host shared with both handlers.
#[derive(Clone)]
pub struct WebHost {
    pub search: SearchConfig,
    pub fetch: FetchConfig,
    pub get: Getter,
}

impl WebHost {
    /// Default backend: DDG html, no key, standard caps.
    #[must_use]
    pub fn default_backend(get: Getter) -> Self {
        Self {
            search: SearchConfig {
                endpoint: DDG_HTML_ENDPOINT.to_string(),
                api_key: None,
            },
            fetch: FetchConfig {
                max_bytes: FETCH_DEFAULT_MAX_BYTES,
                max_redirects: FETCH_DEFAULT_MAX_REDIRECTS,
            },
            get,
        }
    }
}

/// Current UTC year, no chrono for one header. Days-to-civil, proleptic
/// Gregorian (inverse of the retry date parser).
#[must_use]
pub fn current_year() -> i32 {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    (yoe + era * 400) as i32
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else if b == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// Strip `<...>` tags, leaving text. Anchor scanner input, not a parser.
fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in s.chars() {
        match c {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Best-effort result anchors from DDG-style html: `<a ... href="H">T</a>`.
/// DDG wraps outlinks as `/l/?...&uddg=<encoded>`; the real target is the
/// `uddg` value. Anything else starting with http passes through.
fn anchor_hits(html: &str) -> Vec<(String, String)> {
    let mut hits = Vec::new();
    let mut rest = html;
    while let Some(a) = rest.find("<a ") {
        let tag = &rest[a..];
        let Some(href_at) = tag.find("href=\"") else {
            rest = &tag[3..];
            continue;
        };
        let href_start = a + href_at + 6;
        let Some(end) = rest[href_start..].find('"') else {
            break;
        };
        let href = &rest[href_start..href_start + end];
        let after = &rest[href_start + end..];
        let Some(close) = after.find('>') else {
            break;
        };
        let text_start = href_start + end + close + 1;
        let text = rest[text_start..].split("</a>").next().unwrap_or("");
        let url = if let Some(u) = href.split("uddg=").nth(1) {
            percent_decode_simple(u.split('&').next().unwrap_or(""))
        } else {
            href.to_string()
        };
        if url.starts_with("http") && !strip_tags(text).is_empty() {
            hits.push((strip_tags(text), url));
            if hits.len() >= 10 {
                break;
            }
        }
        rest = &rest[text_start..];
    }
    hits
}

fn percent_decode_simple(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let triplet = if bytes[i] == b'%' && i + 2 < bytes.len() {
            match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(hi), Some(lo)) => Some(hi << 4 | lo),
                _ => None,
            }
        } else {
            None
        };
        if let Some(decoded) = triplet {
            out.push(decoded);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

impl WebHost {
    fn search_run(&self, input: &Value) -> Result<String, HttpError> {
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .filter(|q| !q.trim().is_empty())
            .ok_or_else(|| HttpError::Transport("search needs a query".to_string()))?;
        let with_year = format!("{} {}", query.trim(), current_year());
        let url = format!("{}?q={}", self.search.endpoint, percent_encode(&with_year));
        let mut headers = Vec::new();
        if let Some(key) = &self.search.api_key {
            headers.push(("Authorization".to_string(), format!("Bearer {key}")));
        }
        let res = (self.get)(&HttpRequest {
            url,
            headers,
            body: None,
        })?;
        if res.status >= 400 {
            return Err(HttpError::Transport(format!(
                "search status {}",
                res.status
            )));
        }
        let text = String::from_utf8_lossy(&res.body_bytes);
        // JSON results shape first; DDG-style anchors second.
        if let Ok(json) = serde_json::from_str::<Value>(&text) {
            if let Some(results) = json.get("results").and_then(Value::as_array) {
                let mut out = String::new();
                for (i, r) in results.iter().take(10).enumerate() {
                    let title = r.get("title").and_then(Value::as_str).unwrap_or("");
                    let link = r.get("url").and_then(Value::as_str).unwrap_or("");
                    let snippet = r
                        .get("snippet")
                        .or_else(|| r.get("description"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    out.push_str(&format!("{}. {title}\n   {link}\n   {snippet}\n", i + 1));
                }
                if !out.is_empty() {
                    return Ok(out);
                }
            }
        }
        let anchors = anchor_hits(&text);
        if anchors.is_empty() {
            return Err(HttpError::NoResults);
        }
        Ok(anchors
            .iter()
            .enumerate()
            .map(|(i, (t, u))| format!("{}. {t}\n   {u}", i + 1))
            .collect::<Vec<_>>()
            .join("\n"))
    }

    fn join_url(&self, base: &str, location: &str) -> String {
        if location.starts_with("http://") || location.starts_with("https://") {
            return location.to_string();
        }
        if let Some(scheme_end) = base.find("://") {
            let rest = &base[scheme_end + 3..];
            let host_end = rest.find('/').unwrap_or(rest.len());
            let host = &rest[..host_end];
            if location.starts_with('/') {
                return format!("{}://{}{}", &base[..scheme_end], host, location);
            }
            let base_dir = rest.rfind('/').map(|i| &rest[..i + 1]).unwrap_or("");
            return format!("{}://{}{base_dir}{location}", &base[..scheme_end], host);
        }
        location.to_string()
    }

    fn fetch_run(&self, input: &Value) -> Result<String, HttpError> {
        let url = input
            .get("url")
            .and_then(Value::as_str)
            .filter(|u| !u.trim().is_empty())
            .ok_or_else(|| HttpError::Transport("fetch needs a url".to_string()))?;
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(HttpError::Transport(format!("refused scheme: {url}")));
        }
        let mut current = url.to_string();
        let mut visited = vec![current.clone()];
        let mut res = None;
        for _ in 0..=self.fetch.max_redirects {
            let r = (self.get)(&HttpRequest {
                url: current.clone(),
                headers: vec![],
                body: None,
            })?;
            if r.status >= 400 {
                return Err(HttpError::Transport(format!("fetch status {}", r.status)));
            }
            match r.status {
                301 | 302 | 303 | 307 | 308 => {
                    let next = header(&r.headers, "location").ok_or_else(|| {
                        HttpError::TooManyRedirects("redirect without location".to_string())
                    })?;
                    let next = self.join_url(&current, next);
                    if visited.contains(&next) {
                        return Err(HttpError::TooManyRedirects(format!(
                            "redirect loop at {next}"
                        )));
                    }
                    visited.push(next.clone());
                    current = next;
                }
                _ => {
                    res = Some(r);
                    break;
                }
            }
        }
        let res = res.ok_or_else(|| {
            HttpError::TooManyRedirects(format!(
                "over {} hops from {url}",
                self.fetch.max_redirects
            ))
        })?;
        let content_type = header(&res.headers, "content-type")
            .unwrap_or("")
            .to_lowercase();
        let mut raw = res.body_bytes;
        let mut cut = false;
        if raw.len() > self.fetch.max_bytes {
            // Back up over continuation bytes so the cut never splits a codepoint.
            let mut end = self.fetch.max_bytes;
            while end > 0 && (raw[end] & 0xC0) == 0x80 {
                end -= 1;
            }
            raw.truncate(end);
            cut = true;
        }
        let total_note = if cut {
            format!(
                "\n\n[truncated: showing ~{} of over {} bytes]",
                raw.len(),
                self.fetch.max_bytes
            )
        } else {
            String::new()
        };
        if content_type.contains("html") {
            Ok(format!(
                "{}{total_note}",
                html2text::from_read(&raw[..], HTML_WIDTH).unwrap_or_default()
            ))
        } else if content_type.contains("text/") || content_type.is_empty() {
            Ok(format!("{}{total_note}", String::from_utf8_lossy(&raw)))
        } else {
            Err(HttpError::UnsupportedType(content_type))
        }
    }

    fn search_cmd(&self, input: &Value, _ctx: &ToolContext) -> ToolOutcome {
        match self.search_run(input) {
            Ok(preview) => ToolOutcome::Ok {
                preview,
                preview_path: None,
                full_path: None,
            },
            Err(e) => ToolOutcome::Error {
                message: e.to_string(),
            },
        }
    }

    fn fetch_cmd(&self, input: &Value, _ctx: &ToolContext) -> ToolOutcome {
        match self.fetch_run(input) {
            Ok(preview) => ToolOutcome::Ok {
                preview,
                preview_path: None,
                full_path: None,
            },
            Err(e) => ToolOutcome::Error {
                message: e.to_string(),
            },
        }
    }
}

/// Production getter: reqwest blocking, no auto-redirects (the loop handles
/// hops so loops stay visible), 30s timeout.
#[must_use]
pub fn reqwest_getter() -> Getter {
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("clauro/1.0")
        .build();
    Arc::new(move |req: &HttpRequest| {
        let client = client
            .as_ref()
            .map_err(|e| HttpError::Transport(format!("client build: {e}")))?
            .clone();
        let mut builder = client.get(&req.url);
        for (k, v) in &req.headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        let res = builder
            .send()
            .map_err(|e| HttpError::Transport(e.to_string()))?;
        let status = res.status().as_u16();
        let headers = res
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let body = res
            .bytes()
            .map_err(|e| HttpError::Transport(e.to_string()))?
            .to_vec();
        Ok(HttpResponse {
            status,
            headers,
            body_bytes: body,
        })
    })
}

/// Bind both web handlers onto a shared host.
pub fn register_web(reg: &mut Registry, host: Arc<WebHost>) {
    let search_host = host.clone();
    let _ = reg.set_handler("web-search", move |input: &Value, ctx: &ToolContext| {
        search_host.search_cmd(input, ctx)
    });
    let _ = reg.set_handler("web-fetch", move |input: &Value, ctx: &ToolContext| {
        host.fetch_cmd(input, ctx)
    });
}
