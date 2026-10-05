//! Registry: the fixed eight, identity epochs, and typed dispatch.
//!
//! D108: the tool set is fixed at eight — registering a ninth name, or
//! binding a handler to an unknown name, fails. Nothing loads code at
//! runtime. D19: `materialize()` captures an identity epoch; `dispatch()`
//! on a stale epoch is a typed `Stale tool call` error, never a call.
//! D55: every path out of `dispatch` is a `ToolOutcome`, panics included.

use clauro_core::{ToolContext, ToolOutcome};
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;

/// The fixed tool set, in canonical order.
pub const EIGHT: [&str; 8] = [
    "memory",
    "artifact",
    "web-search",
    "web-fetch",
    "fs",
    "compact",
    "bash",
    "question",
];

/// One registered tool. Descriptions are ours, written from scratch (D39);
/// input schemas start as open objects and are refined by the handler tasks
/// (008–012) that own each contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub writes_to_disk: bool,
}

type Handler = Box<dyn Fn(&Value, &ToolContext) -> ToolOutcome + Send + Sync>;

/// Why setup failed. Runtime failures are `ToolOutcome`, never this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    FixedSet(String),
    Duplicate(String),
    UnknownTool(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FixedSet(n) => write!(f, "tool set is fixed at eight, refusing: {n}"),
            Self::Duplicate(n) => write!(f, "tool already registered: {n}"),
            Self::UnknownTool(n) => write!(f, "no such tool: {n}"),
        }
    }
}

impl std::error::Error for RegistryError {}

/// A materialised request surface: tool definitions plus the identity epoch
/// the next dispatch must present.
#[derive(Debug, Clone, PartialEq)]
pub struct Materialization {
    pub epoch: u64,
    pub tools: Vec<ToolDefinition>,
}

/// An incoming model call with the epoch it was materialised against.
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingCall {
    pub name: String,
    pub input: Value,
    pub epoch: u64,
}

/// The eight definitions with our own descriptions. Schemas are open
/// objects until the owning handler task refines them.
#[must_use]
pub fn eight_definitions() -> Vec<ToolDefinition> {
    let object = || serde_json::json!({"type": "object"});
    vec![
        ToolDefinition {
            name: "memory".to_string(),
            description: "Keep small durable notes the user asked to remember, scoped to a topic. Reads merge into the reply; writes replace one topic at a time and never store secrets.".to_string(),
            // Refined by 008, which owns this contract: six commands over
            // project-scoped topic rows.
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": {"enum": ["view", "create", "str_replace", "insert", "delete", "rename", "reset"]},
                    "path": {"type": "string"},
                    "category": {"type": "string"},
                    "body": {"type": "string"},
                    "old_str": {"type": "string"},
                    "new_str": {"type": "string"},
                    "text": {"type": "string"},
                    "line": {"type": "integer"},
                    "old_path": {"type": "string"},
                    "new_path": {"type": "string"},
                    "sensitive": {"type": "boolean"},
                    "confirm": {"type": "boolean"},
                },
            }),
            writes_to_disk: true,
        },
        ToolDefinition {
            name: "artifact".to_string(),
            description: "Render a self-contained document, page, or graphic in the side drawer from a title, media type, and source. Runs with no network and no access to the app.".to_string(),
            input_schema: object(),
            writes_to_disk: true,
        },
        ToolDefinition {
            name: "web-search".to_string(),
            description: "Search the public web and return short cited hits. Pass the current year with the query so time-sensitive questions anchor correctly.".to_string(),
            // Refined by 011, which owns this contract: query in, cited hits out.
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["query"],
                "properties": {"query": {"type": "string"}},
            }),
            writes_to_disk: false,
        },
        ToolDefinition {
            name: "web-fetch".to_string(),
            description: "Read one page into text. Prefer a more targeted tool when one is present; large pages arrive truncated with the remainder addressable.".to_string(),
            // Refined by 011: url in, markdown out, hops and bytes bounded.
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["url"],
                "properties": {"url": {"type": "string"}},
            }),
            writes_to_disk: false,
        },
        ToolDefinition {
            name: "fs".to_string(),
            description: "Read, list, write, and edit files inside the session workspace only. Paths outside are refused, and edit needs a prior read of the same path.".to_string(),
            // Refined by 010, which owns this contract: read/list/glob/grep
            // over session + project, writes and edits session-only.
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": {"enum": ["read", "list", "glob", "grep", "write", "edit"]},
                    "path": {"type": "string"},
                    "scope": {"enum": ["session", "project"]},
                    "pattern": {"type": "string"},
                    "offset": {"type": "integer"},
                    "limit": {"type": "integer"},
                    "content": {"type": "string"},
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                    "replace_all": {"type": "boolean"},
                },
            }),
            writes_to_disk: true,
        },
        ToolDefinition {
            name: "compact".to_string(),
            description: "Summarise the thread so far into a checkpoint. Host-driven only: it never appears in the request schema and runs from the /compact command.".to_string(),
            input_schema: object(),
            writes_to_disk: false,
        },
        ToolDefinition {
            name: "bash".to_string(),
            description: "Run one shell command after the user approves it, every time, with nothing remembered between runs. Off unless the project opts in.".to_string(),
            input_schema: object(),
            writes_to_disk: true,
        },
        ToolDefinition {
            name: "question".to_string(),
            description: "Ask the user one inline question with options and a skip choice, at most once per turn. Secret-shaped prompts are refused.".to_string(),
            input_schema: object(),
            writes_to_disk: false,
        },
    ]
}

pub struct Registry {
    defs: HashMap<String, ToolDefinition>,
    handlers: HashMap<String, Handler>,
    epoch: u64,
}

impl Registry {
    /// All eight definitions, no handlers. Handlers bind in 008–012.
    #[must_use]
    pub fn with_eight() -> Self {
        let defs = eight_definitions()
            .into_iter()
            .map(|d| (d.name.clone(), d))
            .collect();
        Self {
            defs,
            handlers: HashMap::new(),
            epoch: 0,
        }
    }

    /// Names in canonical order.
    #[must_use]
    pub fn names(&self) -> Vec<String> {
        EIGHT.iter().map(|s| s.to_string()).collect()
    }

    /// Our own description for a tool, if registered.
    #[must_use]
    pub fn description(&self, name: &str) -> Option<String> {
        self.defs.get(name).map(|d| d.description.clone())
    }

    /// Register one of the eight with a handler-less definition. Anything
    /// outside the fixed set fails (D108).
    pub fn register(
        &mut self,
        name: &str,
        description: &str,
        input_schema: Value,
        writes_to_disk: bool,
    ) -> Result<(), RegistryError> {
        if !EIGHT.contains(&name) {
            return Err(RegistryError::FixedSet(name.to_string()));
        }
        if self.defs.contains_key(name) {
            return Err(RegistryError::Duplicate(name.to_string()));
        }
        self.defs.insert(
            name.to_string(),
            ToolDefinition {
                name: name.to_string(),
                description: description.to_string(),
                input_schema,
                writes_to_disk,
            },
        );
        Ok(())
    }

    /// Bind a handler to a known tool. Unknown names fail: no runtime tool
    /// loading (D108).
    pub fn set_handler(
        &mut self,
        name: &str,
        handler: impl Fn(&Value, &ToolContext) -> ToolOutcome + Send + Sync + 'static,
    ) -> Result<(), RegistryError> {
        if !self.defs.contains_key(name) {
            return Err(RegistryError::UnknownTool(name.to_string()));
        }
        self.handlers.insert(name.to_string(), Box::new(handler));
        Ok(())
    }

    /// Freeze the current surface and capture its identity epoch.
    pub fn materialize(&mut self) -> Materialization {
        self.epoch += 1;
        Materialization {
            epoch: self.epoch,
            tools: EIGHT
                .iter()
                .filter_map(|n| self.defs.get(*n).cloned())
                .collect(),
        }
    }

    /// Dispatch, returning an outcome on every path. Unknown tools, stale
    /// epochs, unbound handlers, malformed input, and panicking handlers all
    /// become typed `error` results — nothing throws (D55).
    pub fn dispatch(&self, call: &IncomingCall, ctx: &ToolContext) -> ToolOutcome {
        if call.epoch != self.epoch {
            return ToolOutcome::Error {
                message: "Stale tool call: the surface changed since materialisation".to_string(),
            };
        }
        let Some(handler) = self.handlers.get(&call.name) else {
            return ToolOutcome::Error {
                message: format!("no handler bound for tool: {}", call.name),
            };
        };
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&call.input, ctx)))
            .unwrap_or(ToolOutcome::Error {
                message: format!("tool {} failed without a result", call.name),
            })
    }
}
