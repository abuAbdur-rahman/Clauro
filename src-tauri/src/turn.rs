//! Turn driver: Tauri commands → send loop → `clauro-loop` → transcript (023).
//!
//! This is the host obligation `Tasks/023` names: "nothing observes idleness
//! and starts the next turn". The loop exposes `run_turn`/`drain_next`/`stop`;
//! this module owns the store handle, the registry bindings, the HTTP
//! exchange, and the event channel that makes a turn *stream* in the app.
//!
//! Threading (`D55`, `D68`): a turn runs on a dedicated `std::thread` with
//! `reqwest::blocking`, never on a Tokio worker — blocking an async worker on
//! a minutes-long provider stream would hang the window. The `Exchange` trait
//! stays synchronous, so `drive_turn` needs no async rewrite.
//!
//! Stop without deadlock: the running turn holds the `TurnLoop` mutex for its
//! whole duration, so `turn_stop` must not need that mutex. The stop flag
//! `Arc` is cloned into a side map before the thread spawns; stopping sets the
//! `AtomicBool` directly, and the loop's own `stopped()` reads the same
//! allocation. Same flag, no lock.
//!
//! Provider routing: `turn_start` reads the provider row first. Anthropic is
//! the live path; OpenAI-compatible rows are configured (key + models work)
//! but turns need the request translator, so they fail typed
//! (`UnsupportedProvider`) rather than sending an Anthropic-shaped body at an
//! endpoint that would 400 it. An unknown id is `NoProvider`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use clauro_loop::{
    blocks_to_contract,
    run::{Exchange, ExchangeFailure, LoopError, PreparedThread, TurnLoop, TurnPlan, TurnReport},
    RenderRow,
};
use clauro_store::{NewThread, Store};
use clauro_transport::{
    retry_delay, AnthropicParser, BuiltRequest, InboundKind, NormalisedEvent, SseFramer,
    StreamParser,
};

/// Per-event channel: emitted as each provider event arrives.
pub const TURN_EVENT: &str = "clauro://turn-event";
/// Terminal channel: emitted once, when the turn ends for any reason.
pub const TURN_DONE: &str = "clauro://turn-done";

/// Anthropic API version header. Pinned: the wire shape the adapters parse is
/// versioned by this value.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic messages endpoint. The one URL the shell is allowed to know.
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";

/// Effort knob → thinking budget tokens. Our mapping (no documented source):
/// low is the Anthropic minimum that still reasons, medium the value the
/// transport tests already use, high twice that. Effort never enters the
/// frozen hash (D76) — it rides `PreparedThread.thinking_budget` only.
#[must_use]
pub fn thinking_budget(effort: &str) -> u32 {
    match effort {
        "low" => 4_000,
        "high" => 20_000,
        _ => 10_000,
    }
}

/// Validate a start request before touching any state. Blank text or a blank
/// model is `BadInput`, never a turn that immediately fails somewhere louder.
pub fn validate_start(
    thread_id: &str,
    text: &str,
    provider: &str,
    model: &str,
) -> Result<(), TurnError> {
    if thread_id.trim().is_empty() {
        return Err(TurnError::BadInput {
            reason: "thread_id must not be blank".to_string(),
        });
    }
    if text.trim().is_empty() {
        return Err(TurnError::BadInput {
            reason: "text must not be blank".to_string(),
        });
    }
    if provider.trim().is_empty() || model.trim().is_empty() {
        return Err(TurnError::BadInput {
            reason: "a model must be selected before starting a turn".to_string(),
        });
    }
    Ok(())
}

/// Ensure the thread row exists with this frozen hash (D19). Returns whether
/// the thread was created. A live thread with a *different* hash fails typed:
/// extending a prefix the thread did not start with is never done quietly,
/// and the UI answers it by opening a fresh thread (D67).
pub fn ensure_thread(store: &Store, thread_id: &str, frozen_hash: &str) -> Result<bool, TurnError> {
    match store.get_thread(thread_id).map_err(|e| TurnError::Store {
        reason: e.to_string(),
    })? {
        None => {
            store
                .insert_thread(NewThread {
                    id: thread_id.to_string(),
                    project_id: None,
                    title: None,
                    incognito: false,
                    memory_off: false,
                    system_frozen: frozen_hash.to_string(),
                    tools_frozen: String::new(),
                })
                .map_err(|e| TurnError::Store {
                    reason: e.to_string(),
                })?;
            Ok(true)
        }
        Some(row) => {
            if row.system_frozen != frozen_hash {
                return Err(TurnError::PrefixChanged {
                    want: frozen_hash.to_string(),
                    got: row.system_frozen,
                });
            }
            Ok(false)
        }
    }
}

/// The loop's typed refusal, translated to the shell's typed refusal. Every
/// variant maps; there is no fallback arm that invents a message.
#[must_use]
pub fn map_loop_error(e: LoopError) -> TurnError {
    match e {
        LoopError::ThreadMissing(id) => TurnError::ThreadMissing { thread_id: id },
        LoopError::PrefixChanged { want, got } => TurnError::PrefixChanged { want, got },
        LoopError::Store(e) => TurnError::Store {
            reason: e.to_string(),
        },
        LoopError::Approval(e) => TurnError::Transport {
            message: format!("approval error: {e}"),
        },
    }
}

/// One serializable streaming event. A subset of `NormalisedEvent` shaped for
/// the view: deltas carry text, boundaries carry position, usage carries the
/// meter figures. Tool headers ride `block_start` so the view can pair rows.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnEvent {
    BlockStart {
        index: u32,
        kind: String,
        tool_id: Option<String>,
        tool_name: Option<String>,
    },
    TextDelta {
        index: u32,
        text: String,
    },
    ThinkingDelta {
        index: u32,
        text: String,
    },
    BlockStop {
        index: u32,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    Notice {
        text: String,
    },
}

/// Map one provider event to zero or more view events. `Usage` on the wire
/// carries billing + context figures; the view needs the billing pair for the
/// meter. `Stop`/`Ping` are transport housekeeping — the view never sees them.
pub fn map_event(event: &NormalisedEvent) -> Vec<TurnEvent> {
    match event {
        NormalisedEvent::BlockStart { index, kind, tool } => vec![TurnEvent::BlockStart {
            index: *index,
            kind: match kind {
                InboundKind::Text => "text".to_string(),
                InboundKind::Thinking => "thinking".to_string(),
                InboundKind::ToolUse => "tool_use".to_string(),
                InboundKind::Compaction => "compaction".to_string(),
            },
            tool_id: tool.as_ref().map(|t| t.id.clone()),
            tool_name: tool.as_ref().map(|t| t.name.clone()),
        }],
        NormalisedEvent::BlockDelta {
            index,
            text,
            signature: _,
        } => match text {
            // The sink does not know which block kind a delta belongs to; the
            // view appends text deltas to the open text region and thinking
            // deltas to the open thinking region by index. Signature-only
            // deltas carry no renderable text and are dropped here — the
            // signature is persisted by the loop, never rendered.
            Some(t) => vec![TurnEvent::TextDelta {
                index: *index,
                text: t.clone(),
            }],
            None => vec![],
        },
        NormalisedEvent::BlockStop { index } => vec![TurnEvent::BlockStop { index: *index }],
        NormalisedEvent::Usage { usage } => vec![TurnEvent::Usage {
            input_tokens: usage.billing_input_tokens,
            output_tokens: usage.billing_output_tokens,
        }],
        NormalisedEvent::InputTransformed { dropped } => vec![TurnEvent::Notice {
            text: format!("server dropped {dropped} thinking blocks"),
        }],
        NormalisedEvent::Ignored { raw_type } => vec![TurnEvent::Notice {
            text: format!("provider sent {raw_type}, which this app does not render; continuing"),
        }],
        NormalisedEvent::Error { message } => vec![TurnEvent::Notice {
            text: message.clone(),
        }],
        NormalisedEvent::Stop { .. } | NormalisedEvent::Ping => vec![],
    }
}

/// The live HTTP exchange: one Anthropic SSE stream per `step` (D24, D56).
///
/// Blocking client, called from the dedicated turn thread. Retries use
/// `retry_delay` unchanged — the policy's second real caller (the first is
/// `stream_step` in tests). Bytes are framed and parsed incrementally: each
/// parsed event is sunk **before** the next chunk is read, which is what makes
/// the turn stream rather than appear whole.
///
/// Anthropic-only by construction: the loop builds Anthropic-shaped requests,
/// so only an Anthropic-shaped endpoint can receive them. The OpenAI request
/// translator arrives separately; until then `turn_start` refuses compat
/// providers before an exchange is ever built.
pub struct LiveExchange {
    client: reqwest::blocking::Client,
    api_key: String,
}

impl LiveExchange {
    pub fn anthropic(api_key: String) -> Result<Self, TurnError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| TurnError::Transport {
                message: format!("cannot build HTTP client: {e}"),
            })?;
        Ok(Self { client, api_key })
    }

    fn send_once(&self, request: &BuiltRequest) -> Result<reqwest::blocking::Response, TurnError> {
        let mut body = request.body.clone();
        // SSE streaming is a transport concern, not a loop concern: the loop
        // builds a complete request and this layer asks for it as a stream.
        body["stream"] = serde_json::Value::Bool(true);
        let mut req = self
            .client
            .post(ANTHROPIC_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json");
        for (name, value) in &request.headers {
            req = req.header(name.as_str(), value.as_str());
        }
        req.json(&body).send().map_err(|e| {
            // No status exists to back off on (DNS, TLS, refused): report, do
            // not loop on it until the cap.
            if e.is_timeout() {
                TurnError::Transport {
                    message: "provider timed out".to_string(),
                }
            } else if e.is_connect() {
                TurnError::Transport {
                    message: "cannot reach the provider (connection failed)".to_string(),
                }
            } else {
                TurnError::Transport {
                    message: format!("request failed: {e}"),
                }
            }
        })
    }
}

impl Exchange for LiveExchange {
    fn step(
        &mut self,
        request: &BuiltRequest,
        sink: &mut dyn FnMut(NormalisedEvent),
    ) -> Result<Vec<NormalisedEvent>, ExchangeFailure> {
        let mut attempt: u32 = 0;
        loop {
            let resp = match self.send_once(request) {
                Ok(r) => r,
                Err(e) => {
                    return Err(ExchangeFailure {
                        message: e.to_string(),
                    });
                }
            };
            let status = resp.status().as_u16();
            if status != 200 {
                let retry_after = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                // Read the error body for a human message, bounded: an error
                // page can be megabytes and none of it renders.
                let detail: String = resp.text().unwrap_or_default().chars().take(500).collect();
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                match retry_delay(status, retry_after.as_deref(), attempt, now) {
                    Some(delay) => {
                        if !delay.is_zero() {
                            std::thread::sleep(delay);
                        }
                        attempt += 1;
                        continue;
                    }
                    None => {
                        return Err(ExchangeFailure {
                            message: if detail.trim().is_empty() {
                                format!("provider returned HTTP {status}")
                            } else {
                                format!("provider returned HTTP {status}: {}", detail.trim())
                            },
                        });
                    }
                }
            }
            // 200: frame + parse incrementally, sinking each event before the
            // next chunk is read. A fresh framer per step: resuming a stale
            // buffer across steps would replay a judged prefix.
            let mut framer = SseFramer::new();
            let mut parser: Box<dyn StreamParser> = Box::new(AnthropicParser::new());
            let mut out = Vec::new();
            let mut stream = resp;
            let mut buf = [0u8; 8192];
            use std::io::Read as _;
            loop {
                match stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let raw = framer.feed(&buf[..n]).map_err(|e| ExchangeFailure {
                            message: format!("stream framing failed: {e}"),
                        })?;
                        for event in raw {
                            for normalised in parser.feed(&event) {
                                sink(normalised.clone());
                                out.push(normalised);
                            }
                        }
                    }
                    Err(e) => {
                        return Err(ExchangeFailure {
                            message: format!("stream read failed: {e}"),
                        });
                    }
                }
            }
            for event in framer.finish() {
                for normalised in parser.feed(&event) {
                    sink(normalised.clone());
                    out.push(normalised);
                }
            }
            return Ok(out);
        }
    }
}

/// Shared turn state, managed by Tauri. Every field is an `Arc` so the spawned
/// turn thread can own its handles without borrowing the managed value.
pub struct TurnState {
    pub store: Arc<Mutex<Store>>,
    pub turns: Arc<Mutex<TurnLoop>>,
    pub stops: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub running: Arc<Mutex<HashSet<String>>>,
    pub data_dir: PathBuf,
}

impl TurnState {
    pub fn new(store: Store, data_dir: PathBuf) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            turns: Arc::new(Mutex::new(TurnLoop::new())),
            stops: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(Mutex::new(HashSet::new())),
            data_dir,
        }
    }

    /// Open (creating) the file-backed store under `data_dir`.
    pub fn open(data_dir: &Path) -> Result<Self, TurnError> {
        std::fs::create_dir_all(data_dir).map_err(|e| TurnError::Store {
            reason: format!("cannot create data dir: {e}"),
        })?;
        let db_path = data_dir.join("clauro.db");
        let store = Store::open(&db_path).map_err(|e| TurnError::Store {
            reason: e.to_string(),
        })?;
        Ok(Self::new(store, data_dir.to_path_buf()))
    }

    /// Session workspace for a thread. Created on demand; the `fs` tool is
    /// rooted here and nowhere else (D31).
    pub fn session_dir(&self, thread_id: &str) -> Result<PathBuf, TurnError> {
        let dir = self.data_dir.join("sessions").join(thread_id);
        std::fs::create_dir_all(&dir).map_err(|e| TurnError::Store {
            reason: format!("cannot create session dir: {e}"),
        })?;
        Ok(dir)
    }

    /// Project directory for reads. The default project has no files yet; the
    /// directory exists so `FsHost` can canonicalise it.
    pub fn project_dir(&self) -> Result<PathBuf, TurnError> {
        let dir = self.data_dir.join("projects").join("default");
        std::fs::create_dir_all(&dir).map_err(|e| TurnError::Store {
            reason: format!("cannot create project dir: {e}"),
        })?;
        Ok(dir)
    }
}

/// Build the per-turn registry: the fixed eight with live handlers bound.
/// `bash` stays unbound unless the project opts in (D28, D46) — an unbound
/// tool resolves through permissions, never by accident.
pub fn build_registry(
    store: Arc<Mutex<Store>>,
    session_dir: &Path,
    project_dir: &Path,
    bash_enabled: bool,
) -> Result<clauro_tools::Registry, TurnError> {
    use clauro_tools::{
        register_fs, register_question, register_web, FetchConfig, FsHost, WebHost,
    };
    let mut reg = clauro_tools::Registry::with_eight();
    reg.set_handler("memory", clauro_tools::memory_handler(store.clone()))
        .map_err(|e| TurnError::Store {
            reason: format!("cannot bind memory: {e}"),
        })?;
    register_question(&mut reg);
    let fshost = Arc::new(
        FsHost::new(session_dir, project_dir, None, store).map_err(|e| TurnError::Store {
            reason: format!("cannot root fs host: {e}"),
        })?,
    );
    register_fs(&mut reg, fshost.clone());
    let webhost = Arc::new(WebHost {
        search: clauro_tools::SearchConfig {
            endpoint: "https://html.duckduckgo.com/html/".to_string(),
            api_key: None,
        },
        fetch: FetchConfig {
            max_bytes: 200_000,
            max_redirects: 3,
        },
        get: clauro_tools::reqwest_getter(),
    });
    register_web(&mut reg, webhost);
    // Artifact revisions persist through the store-backed host.
    clauro_tools::register_artifact(&mut reg, fshost.clone());
    if bash_enabled {
        clauro_tools::register_bash(&mut reg, fshost);
    }
    Ok(reg)
}

/// Assemble the frozen prompt + hash for a turn. The tool inventory is the
/// fixed eight's definitions; per-project memory instructions arrive later
/// with 018.
#[must_use]
pub fn first_turn() -> (String, String) {
    let defs = clauro_tools::eight_definitions();
    clauro_loop::prompt::first_turn_setup(&defs, None)
}

/// Read one thread's transcript as contract rows, in store order. Total: an
/// unknown thread is an empty transcript, not an error — the view renders the
/// empty state either way.
pub fn read_transcript(state: &TurnState, thread_id: &str) -> Result<Vec<RenderRow>, TurnError> {
    let store = state.store.lock().map_err(|_| TurnError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    if store
        .get_thread(thread_id)
        .map_err(|e| TurnError::Store {
            reason: e.to_string(),
        })?
        .is_none()
    {
        return Ok(Vec::new());
    }
    Ok(blocks_to_contract(&store.blocks_for_thread(thread_id)))
}

/// Typed shell failure. No key material, ever — variants carry reasons.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TurnError {
    BadInput {
        reason: String,
    },
    Busy {
        thread_id: String,
    },
    NoKey {
        provider: String,
    },
    /// The provider id has no row: never configured, or removed since.
    NoProvider {
        provider: String,
    },
    /// Configured, but this build cannot speak its wire yet. Today that is
    /// every OpenAI-compatible provider: key + models work, turns need the
    /// Anthropic→chat-completions request translator (tracked, not silent).
    UnsupportedProvider {
        provider: String,
    },
    ThreadMissing {
        thread_id: String,
    },
    PrefixChanged {
        want: String,
        got: String,
    },
    Transport {
        message: String,
    },
    Store {
        reason: String,
    },
}

impl std::fmt::Display for TurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadInput { reason } => write!(f, "bad turn input: {reason}"),
            Self::Busy { thread_id } => write!(f, "a turn is already running on {thread_id}"),
            Self::NoKey { provider } => write!(
                f,
                "no API key for {provider} in the keychain; add one before starting a turn"
            ),
            Self::NoProvider { provider } => write!(
                f,
                "provider {provider} is not configured; add it before starting a turn"
            ),
            Self::UnsupportedProvider { provider } => write!(
                f,
                "provider {provider} is configured but live turns need the OpenAI request translator, which is not built yet"
            ),
            Self::ThreadMissing { thread_id } => write!(f, "no such thread: {thread_id}"),
            Self::PrefixChanged { want, got } => write!(
                f,
                "thread started with a different tool set (want {want}, got {got}); open a fresh thread"
            ),
            Self::Transport { message } => write!(f, "provider error: {message}"),
            Self::Store { reason } => write!(f, "store error: {reason}"),
        }
    }
}

impl std::error::Error for TurnError {}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// What `turn_start` returns immediately. The turn itself runs on a dedicated
/// thread and reports through `TURN_EVENT`/`TURN_DONE` — awaiting the whole
/// turn inside the command would block the invoke round-trip for minutes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TurnStarted {
    pub thread_id: String,
}

/// Start a turn: validate, resolve the key, ensure the thread, then hand the
/// work to a dedicated thread and return at once.
///
/// One turn per thread at a time: a second start while one runs fails typed
/// (`Busy`) rather than interleaving two loops on one transcript.
// Eight arguments because Tauri commands take flat invoke args — the
// framework dictates the signature, so bundling is not available here.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn turn_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, TurnState>,
    thread_id: String,
    text: String,
    provider: String,
    model: String,
    effort: String,
    max_tokens: u32,
) -> Result<TurnStarted, TurnError> {
    validate_start(&thread_id, &text, &provider, &model)?;
    // The provider row decides the wire. Anthropic is live; OpenAI-compatible
    // rows are fully configured (key + models work) but turns need the
    // request translator — tracked work, refused here rather than sent as a
    // body the endpoint would 400. An unknown id is `NoProvider`: the gated
    // picker cannot produce it, so it means a removed provider or a race
    // with removal.
    let kind = {
        let store = state.store.lock().map_err(|_| TurnError::Store {
            reason: "store lock poisoned".to_string(),
        })?;
        match store
            .get_provider(&provider)
            .map_err(|e| TurnError::Store {
                reason: e.to_string(),
            })? {
            None => {
                return Err(TurnError::NoProvider {
                    provider: provider.clone(),
                });
            }
            Some(row) => row.kind,
        }
    };
    if kind != clauro_store::ProviderKind::Anthropic {
        return Err(TurnError::UnsupportedProvider { provider });
    }
    // The key lives in the OS keychain under the provider name. Read it here,
    // on the command thread, so the turn thread never touches the keychain —
    // and the key itself never crosses into an event payload.
    let api_key = crate::keyring_store::retrieve(&provider).map_err(|_| TurnError::NoKey {
        provider: provider.clone(),
    })?;
    if api_key.trim().is_empty() {
        return Err(TurnError::NoKey { provider });
    }

    {
        let mut running = state.running.lock().map_err(|_| TurnError::Store {
            reason: "turn lock poisoned".to_string(),
        })?;
        if running.contains(&thread_id) {
            return Err(TurnError::Busy {
                thread_id: thread_id.clone(),
            });
        }
        running.insert(thread_id.clone());
    }

    // Everything the thread needs, cloned out from under the locks. The turn
    // holds the `TurnLoop` mutex for its whole duration; `turn_stop` only
    // touches the side-map flag, so stopping never waits on that mutex.
    let stop_flag = {
        let mut turns = state.turns.lock().map_err(|_| TurnError::Store {
            reason: "turn lock poisoned".to_string(),
        })?;
        let flag = turns.stop_flag(&thread_id);
        flag.store(false, Ordering::SeqCst);
        state
            .stops
            .lock()
            .map_err(|_| TurnError::Store {
                reason: "turn lock poisoned".to_string(),
            })?
            .insert(thread_id.clone(), flag.clone());
        flag
    };
    let _ = stop_flag;

    let store = state.store.clone();
    let turns = state.turns.clone();
    let stops = state.stops.clone();
    let running = state.running.clone();
    let thread_owned = thread_id.clone();
    let session_dir = state.session_dir(&thread_id)?;
    let project_dir = state.project_dir()?;
    let budget = thinking_budget(&effort);
    let max = max_tokens.max(1_024);

    std::thread::Builder::new()
        .name(format!("clauro-turn-{thread_owned}"))
        .spawn(move || {
            let outcome = run_turn_blocking(TurnJob {
                store: &store,
                turns: &turns,
                app: &app,
                thread_id: &thread_owned,
                start: TurnStartKind::New { text: &text },
                model: &model,
                budget,
                max_tokens: max,
                api_key: &api_key,
                session_dir: &session_dir,
                project_dir: &project_dir,
            });
            finish_turn(&running, &stops, &app, &thread_owned, outcome);
        })
        .map_err(|e| TurnError::Store {
            reason: format!("cannot spawn turn thread: {e}"),
        })?;

    Ok(TurnStarted { thread_id })
}

/// The turn is over however it ended: release the slot first so a retry is
/// never refused by a finished turn, then report. A missed done-event is
/// repaired by `transcript_read`: the store is the record, the event is the
/// hint, so this emit may fail (no listener yet) without failing the turn.
fn finish_turn(
    running: &Arc<Mutex<HashSet<String>>>,
    stops: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    app: &tauri::AppHandle,
    thread_id: &str,
    outcome: Result<TurnReport, TurnError>,
) {
    use tauri::Emitter as _;
    if let Ok(mut r) = running.lock() {
        r.remove(thread_id);
    }
    if let Ok(mut s) = stops.lock() {
        s.remove(thread_id);
    }
    let payload = match &outcome {
        Ok(report) => serde_json::json!({
            "thread_id": thread_id,
            "end": format!("{:?}", report.end),
            "dispatched": report.dispatched,
            "assistant_messages": report.assistant_messages,
            "pending_approvals": report.pending_approvals,
            "pending_question": report.pending_question,
        }),
        Err(e) => serde_json::json!({ "thread_id": thread_id, "error": e.to_string() }),
    };
    let _ = app.emit(TURN_DONE, payload);
}

/// Everything one turn needs that is fixed before it spawns. Bundled so the
/// blocking bodies take one argument instead of eleven.
struct TurnJob<'a> {
    store: &'a Arc<Mutex<Store>>,
    turns: &'a Arc<Mutex<TurnLoop>>,
    app: &'a tauri::AppHandle,
    thread_id: &'a str,
    start: TurnStartKind<'a>,
    model: &'a str,
    budget: u32,
    max_tokens: u32,
    api_key: &'a str,
    session_dir: &'a Path,
    project_dir: &'a Path,
}

/// How the spawned turn begins: a fresh user message, or a resumed turn
/// after an answer (or approval) without one.
enum TurnStartKind<'a> {
    New { text: &'a str },
    Resume,
}

/// The shared half of every blocking turn body: thread row (new turns only),
/// registry bindings, request surface, and the live exchange. Returns the
/// registry, the prepared surface, and the exchange; the caller drives.
fn prepare_loop(
    job: &TurnJob<'_>,
    ensure_thread_row: bool,
) -> Result<(clauro_tools::Registry, PreparedThread, LiveExchange), TurnError> {
    let (system_text, frozen_hash) = first_turn();
    if ensure_thread_row {
        let guard = job.store.lock().map_err(|_| TurnError::Store {
            reason: "store lock poisoned".to_string(),
        })?;
        ensure_thread(&guard, job.thread_id, &frozen_hash)?;
    }
    let registry = build_registry(job.store.clone(), job.session_dir, job.project_dir, false)?;
    // The request surface: the safe six, granted. `bash` stays out (D28) and
    // `compact` never reaches the schema (D14) — `materialize` enforces both
    // structurally rather than by convention.
    let granted = {
        use clauro_tools::{materialize, ThreadToolState};
        let mut state = ThreadToolState::default();
        for name in [
            "memory",
            "artifact",
            "web-search",
            "web-fetch",
            "fs",
            "question",
        ] {
            state.granted.insert(name.to_string());
        }
        materialize(None, &state).anthropic_tools
    };
    let prepared = PreparedThread {
        system_text,
        frozen_hash,
        model: job.model.to_string(),
        max_tokens: job.max_tokens,
        tools: granted,
        thinking_budget: job.budget,
        rules: Vec::new(),
    };
    let exchange = LiveExchange::anthropic(job.api_key.to_string())?;
    Ok((registry, prepared, exchange))
}

/// The streaming sink every turn shares: each mapped event emitted as it
/// arrives, thinking deltas routed by open block kind. Persistence is the
/// record and events are hints, so a failed emit never fails the turn.
fn streaming_sink<'a>(
    app: &'a tauri::AppHandle,
    thread_id: &'a str,
) -> impl FnMut(NormalisedEvent) + 'a {
    use tauri::Emitter as _;
    let app_each = app.clone();
    let tid = thread_id.to_string();
    // Open block kinds by index. `BlockDelta` carries no kind, so the sink
    // remembers what each open index is: thinking text streams as
    // `thinking_delta`, everything else renderable as `text_delta`.
    let mut open_kinds: HashMap<u32, InboundKind> = HashMap::new();
    move |event: NormalisedEvent| {
        if let NormalisedEvent::BlockStart { index, kind, .. } = &event {
            open_kinds.insert(*index, *kind);
        }
        let mut views = map_event(&event);
        if let NormalisedEvent::BlockDelta { index, .. } = &event {
            if open_kinds.get(index) == Some(&InboundKind::Thinking) {
                views = views
                    .into_iter()
                    .map(|v| match v {
                        TurnEvent::TextDelta { index, text } => {
                            TurnEvent::ThinkingDelta { index, text }
                        }
                        other => other,
                    })
                    .collect();
            }
        }
        if let NormalisedEvent::BlockStop { index } = &event {
            open_kinds.remove(index);
        }
        for view in views {
            let payload = serde_json::json!({ "thread_id": tid, "event": view });
            // Same reasoning as TURN_DONE: persistence is the record, the
            // event is the hint. A failed emit must not fail the turn.
            let _ = app_each.emit(TURN_EVENT, payload);
        }
    }
}

/// The blocking body of a turn. Runs on the dedicated thread: shared setup
/// through `prepare_loop`, then `run_turn` or `continue_turn` with the shared
/// streaming sink.
fn run_turn_blocking(job: TurnJob<'_>) -> Result<TurnReport, TurnError> {
    let (mut registry, prepared, mut exchange) =
        prepare_loop(&job, matches!(job.start, TurnStartKind::New { .. }))?;
    let TurnJob {
        store,
        turns,
        app,
        thread_id,
        start,
        session_dir,
        ..
    } = job;
    let mut sink = streaming_sink(app, thread_id);
    let mut guard = turns.lock().map_err(|_| TurnError::Store {
        reason: "turn lock poisoned".to_string(),
    })?;
    let store_guard = store.lock().map_err(|_| TurnError::Store {
        reason: "store lock poisoned".to_string(),
    })?;
    match start {
        TurnStartKind::New { text } => {
            let plan = TurnPlan {
                thread_id,
                user_text: text,
                prepared: &prepared,
                workspace_dir: session_dir,
            };
            guard
                .run_turn(&store_guard, &mut registry, &mut exchange, plan, &mut sink)
                .map_err(map_loop_error)
        }
        TurnStartKind::Resume => guard
            .continue_turn(
                &store_guard,
                &mut registry,
                &mut exchange,
                thread_id,
                &prepared,
                session_dir,
                &mut sink,
            )
            .map_err(map_loop_error),
    }
}

/// Stop a running turn. Sets the shared flag; the loop observes it between
/// steps and between serial dispatches (never inside a handler call), closes
/// open calls as `aborted`, and keeps completed work (D65, D68). Returns
/// whether a turn was actually running.
#[tauri::command]
pub fn turn_stop(state: tauri::State<'_, TurnState>, thread_id: String) -> Result<bool, TurnError> {
    let stops = state.stops.lock().map_err(|_| TurnError::Store {
        reason: "turn lock poisoned".to_string(),
    })?;
    match stops.get(&thread_id) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Read one thread's transcript as contract rows. The repair path for a missed
/// event: whatever the event channel dropped, the store still has.
#[tauri::command]
pub fn transcript_read(
    state: tauri::State<'_, TurnState>,
    thread_id: String,
) -> Result<Vec<RenderRow>, TurnError> {
    read_transcript(&state, &thread_id)
}

/// Answer-side lock/store failure. The message names what failed; the
/// `Store { reason }` shape is used because `StoreError` is neither cloneable
/// nor serializable and this error crosses the Tauri boundary.
fn poisoned(what: &str) -> clauro_loop::run::AnswerError {
    clauro_loop::run::AnswerError::Store {
        reason: format!("{what} lock poisoned"),
    }
}

fn store_failed(e: impl std::fmt::Display) -> clauro_loop::run::AnswerError {
    clauro_loop::run::AnswerError::Store {
        reason: e.to_string(),
    }
}

/// Answer an awaiting question card, then resume the turn (009, D42).
///
/// Validates through `answer_question` — the card's own rules — persists the
/// answer as the call's one `tool_result`, and spawns a continuation on the
/// dedicated thread, so answering resumes the conversation in one round
/// trip. A second answer, an unknown call id, or an answer outside the card
/// fails typed with nothing persisted beyond the first answer. Answering
/// while another turn holds the thread fails `Busy`: stop it first.
// Nine arguments because Tauri commands take flat invoke args — the
// framework dictates the signature, so bundling is not available here.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn question_answer(
    app: tauri::AppHandle,
    state: tauri::State<'_, TurnState>,
    thread_id: String,
    tool_call_id: String,
    answer: String,
    provider: String,
    model: String,
    effort: String,
    max_tokens: u32,
) -> Result<clauro_tools::AnswerResolution, clauro_loop::run::AnswerError> {
    use clauro_loop::run::AnswerError;
    if thread_id.trim().is_empty() || tool_call_id.trim().is_empty() {
        return Err(AnswerError::BadInput {
            reason: "thread and question ids must not be blank".to_string(),
        });
    }
    if provider.trim().is_empty() || model.trim().is_empty() {
        return Err(AnswerError::BadInput {
            reason: "a model must be selected to resume the turn".to_string(),
        });
    }
    // Resume pre-checks, all read-only: the provider must be live-routable
    // and keyed, and no turn may hold the thread. Anything here fails before
    // the answer is persisted, so a refusal never strands half a turn.
    let kind = {
        let store = state.store.lock().map_err(|_| poisoned("store"))?;
        match store.get_provider(&provider).map_err(store_failed)? {
            None => {
                return Err(AnswerError::NoProvider {
                    provider: provider.clone(),
                });
            }
            Some(row) => row.kind,
        }
    };
    if kind != clauro_store::ProviderKind::Anthropic {
        return Err(AnswerError::UnsupportedProvider { provider });
    }
    let api_key = crate::keyring_store::retrieve(&provider).map_err(|_| AnswerError::NoKey {
        provider: provider.clone(),
    })?;
    if api_key.trim().is_empty() {
        return Err(AnswerError::NoKey { provider });
    }
    {
        let running = state.running.lock().map_err(|_| poisoned("turn"))?;
        if running.contains(&thread_id) {
            return Err(AnswerError::Busy {
                thread_id: thread_id.clone(),
            });
        }
    }
    // The answer itself. Short lock: persist and release, never drive.
    let resolution = {
        let turns = state.turns.lock().map_err(|_| poisoned("turn"))?;
        let store = state.store.lock().map_err(|_| poisoned("store"))?;
        turns.answer_question(&store, &thread_id, &tool_call_id, &answer)?
    };
    // Claim the slot and resume exactly like a fresh turn, minus the user
    // message: the answer is already history.
    {
        let mut running = state.running.lock().map_err(|_| poisoned("turn"))?;
        running.insert(thread_id.clone());
    }
    {
        let mut turns = state.turns.lock().map_err(|_| poisoned("turn"))?;
        let flag = turns.stop_flag(&thread_id);
        flag.store(false, Ordering::SeqCst);
        state
            .stops
            .lock()
            .map_err(|_| poisoned("turn"))?
            .insert(thread_id.clone(), flag);
    }
    let store = state.store.clone();
    let turns = state.turns.clone();
    let stops = state.stops.clone();
    let running = state.running.clone();
    let thread_owned = thread_id.clone();
    let session_dir = state.session_dir(&thread_id).map_err(store_failed)?;
    let project_dir = state.project_dir().map_err(store_failed)?;
    let budget = thinking_budget(&effort);
    let max = max_tokens.max(1_024);
    std::thread::Builder::new()
        .name(format!("clauro-turn-{thread_owned}"))
        .spawn(move || {
            let outcome = run_turn_blocking(TurnJob {
                store: &store,
                turns: &turns,
                app: &app,
                thread_id: &thread_owned,
                start: TurnStartKind::Resume,
                model: &model,
                budget,
                max_tokens: max,
                api_key: &api_key,
                session_dir: &session_dir,
                project_dir: &project_dir,
            });
            finish_turn(&running, &stops, &app, &thread_owned, outcome);
        })
        .map_err(|e| AnswerError::Store {
            reason: format!("cannot spawn turn thread: {e}"),
        })?;
    Ok(resolution)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_maps_to_a_documented_budget() {
        assert_eq!(thinking_budget("low"), 4_000);
        assert_eq!(thinking_budget("medium"), 10_000);
        assert_eq!(thinking_budget("high"), 20_000);
    }

    #[test]
    fn unknown_effort_is_a_medium_turn_not_a_crash() {
        assert_eq!(thinking_budget("turbo"), 10_000);
    }

    #[test]
    fn ensure_thread_creates_a_missing_thread() {
        let store = clauro_store::Store::open_memory().expect("store");
        let created = ensure_thread(&store, "t1", "hash-a").expect("ensure");
        assert!(created, "a missing thread is created");
        let row = store.get_thread("t1").expect("read").expect("present");
        assert_eq!(row.system_frozen, "hash-a");
    }

    #[test]
    fn ensure_thread_is_idempotent_on_the_same_hash() {
        let store = clauro_store::Store::open_memory().expect("store");
        assert!(ensure_thread(&store, "t1", "hash-a").expect("first"));
        assert!(
            !ensure_thread(&store, "t1", "hash-a").expect("second"),
            "same hash is a no-op, not a rewrite (D19)"
        );
    }

    #[test]
    fn ensure_thread_refuses_a_changed_prefix() {
        let store = clauro_store::Store::open_memory().expect("store");
        assert!(ensure_thread(&store, "t1", "hash-a").expect("first"));
        match ensure_thread(&store, "t1", "hash-b") {
            Err(TurnError::PrefixChanged { .. }) => {}
            other => panic!("a changed hash must fail typed, got {other:?}"),
        }
    }

    #[test]
    fn blank_text_is_bad_input_not_a_turn() {
        assert!(matches!(
            validate_start("t1", "   ", "anthropic", "m"),
            Err(TurnError::BadInput { .. })
        ));
    }

    #[test]
    fn blank_model_is_bad_input_not_a_turn() {
        assert!(matches!(
            validate_start("t1", "hi", "anthropic", "  "),
            Err(TurnError::BadInput { .. })
        ));
    }

    #[test]
    fn text_deltas_map_to_view_deltas() {
        let out = map_event(&NormalisedEvent::BlockDelta {
            index: 0,
            text: Some("hello".to_string()),
            signature: None,
        });
        assert_eq!(
            out,
            vec![TurnEvent::TextDelta {
                index: 0,
                text: "hello".to_string()
            }]
        );
    }

    #[test]
    fn signature_only_deltas_carry_nothing_renderable() {
        // The signature is persisted by the loop, never rendered.
        let out = map_event(&NormalisedEvent::BlockDelta {
            index: 1,
            text: None,
            signature: Some("sig".to_string()),
        });
        assert!(out.is_empty());
    }

    #[test]
    fn housekeeping_events_never_reach_the_view() {
        assert!(map_event(&NormalisedEvent::Ping).is_empty());
        assert!(map_event(&NormalisedEvent::Stop {
            reason: "end_turn".to_string()
        })
        .is_empty());
    }

    #[test]
    fn usage_maps_to_the_meter_pair() {
        let out = map_event(&NormalisedEvent::Usage {
            usage: clauro_transport::UsageWire {
                top_input_tokens: 0,
                top_output_tokens: 0,
                iterations: vec![],
                billing_input_tokens: 120,
                billing_output_tokens: 34,
                context_input_tokens: 120,
            },
        });
        assert_eq!(
            out,
            vec![TurnEvent::Usage {
                input_tokens: 120,
                output_tokens: 34
            }]
        );
    }

    #[test]
    fn loop_prefix_change_maps_without_losing_the_hashes() {
        let err = map_loop_error(LoopError::PrefixChanged {
            want: "w".to_string(),
            got: "g".to_string(),
        });
        assert_eq!(
            err,
            TurnError::PrefixChanged {
                want: "w".to_string(),
                got: "g".to_string()
            }
        );
    }

    #[test]
    fn reading_an_unknown_thread_is_empty_not_an_error() {
        let state = TurnState::new(
            clauro_store::Store::open_memory().expect("store"),
            std::env::temp_dir(),
        );
        assert_eq!(read_transcript(&state, "nope").expect("read"), Vec::new());
    }

    #[test]
    fn block_start_carries_tool_identity_for_pairing() {
        let out = map_event(&NormalisedEvent::BlockStart {
            index: 2,
            kind: clauro_transport::InboundKind::ToolUse,
            tool: Some(clauro_transport::ToolHeader {
                id: "call-9".to_string(),
                name: "fs".to_string(),
            }),
        });
        assert_eq!(
            out,
            vec![TurnEvent::BlockStart {
                index: 2,
                kind: "tool_use".to_string(),
                tool_id: Some("call-9".to_string()),
                tool_name: Some("fs".to_string()),
            }]
        );
    }

    #[test]
    fn thinking_kind_is_routed_by_the_sink_not_by_map_event() {
        // `map_event` is stateless, so a delta always maps to `text_delta`.
        // The sink rewrites it when the open block is thinking — pinned here
        // through the same rewrite rule the command uses.
        let views = map_event(&NormalisedEvent::BlockDelta {
            index: 1,
            text: Some("hmm".to_string()),
            signature: None,
        });
        let rewritten: Vec<TurnEvent> = views
            .into_iter()
            .map(|v| match v {
                TurnEvent::TextDelta { index, text } => TurnEvent::ThinkingDelta { index, text },
                other => other,
            })
            .collect();
        assert_eq!(
            rewritten,
            vec![TurnEvent::ThinkingDelta {
                index: 1,
                text: "hmm".to_string()
            }]
        );
    }

    #[test]
    fn registry_binds_the_safe_six_and_not_bash() {
        let dir = std::env::temp_dir().join(format!("clauro-turn-reg-{}", std::process::id()));
        let session = dir.join("sessions").join("t1");
        let project = dir.join("projects").join("default");
        std::fs::create_dir_all(&session).expect("session dir");
        std::fs::create_dir_all(&project).expect("project dir");
        let store = Arc::new(Mutex::new(
            clauro_store::Store::open_memory().expect("store"),
        ));
        let reg = build_registry(store, &session, &project, false).expect("registry");
        let names = reg.names();
        for bound in [
            "memory",
            "artifact",
            "web-search",
            "web-fetch",
            "fs",
            "question",
        ] {
            assert!(names.contains(&bound.to_string()), "{bound} must be bound");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_open_creates_a_file_backed_store() {
        let dir = std::env::temp_dir().join(format!("clauro-turn-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = TurnState::open(&dir).expect("open");
        assert!(dir.join("clauro.db").exists(), "the db file must exist");
        let session = state.session_dir("t1").expect("session");
        assert!(session.exists(), "the session dir must exist");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn error_events_surface_as_notices_not_crashes() {
        let out = map_event(&NormalisedEvent::Error {
            message: "boom".to_string(),
        });
        assert_eq!(
            out,
            vec![TurnEvent::Notice {
                text: "boom".to_string()
            }]
        );
    }
}
