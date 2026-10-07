//! `clauro-loop`: the serial turn loop, the system prompt, and the queue.
//!
//! Task 023 owns the loop that drives the registry: stream a step, dispatch
//! `tool_use` blocks serially through `clauro-tools`, persist results to
//! `clauro-store`, re-send until `end_turn` or stop. Tests run headless
//! against scripted exchanges — no provider, no network, no webview.

pub mod prompt;
pub mod queue;
pub mod run;
pub mod seam;

pub use seam::{blocks_to_contract, row_to_contract, RenderRow};
