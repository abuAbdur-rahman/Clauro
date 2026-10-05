//! `clauro-tools`: registry, permissions, bounding, approval, availability.
//!
//! `CONTRACTS.md` §3. Depends on core, store (memory rows), fs (path checks),
//! `serde_json`. Never `tauri` — enforced mechanically in `tests/no_tauri_dep.rs`.

pub mod approval;
pub mod bounding;
pub mod fs;
pub mod materialize;
pub mod memory;
pub mod permission;
pub mod question;
pub mod registry;
pub mod secret;

pub use approval::{ApprovalError, ApprovalQueue, ApprovalState, HeldCall};
pub use bounding::{bound_output, BoundedOutput, BoundingError, PREVIEW_LIMIT_CHARS};
pub use fs::{
    find_session_dir, register_fs, serve_metadata, session_dir, slugify, AttachmentMeta,
    Disposition, FsError, FsHost, ServeMeta,
};
pub use materialize::{
    materialize, Availability, MaterializedTool, ThreadToolState, INLINE_TOOLS_BETA,
};
pub use memory::memory_handler;
pub use permission::resolve;
pub use question::{
    register_question, resolve_answer, AnswerResolution, QuestionError, QuestionGate,
    QUESTION_REFUSAL, SKIP_ID,
};
pub use registry::{
    eight_definitions, IncomingCall, Materialization, Registry, RegistryError, ToolDefinition,
    EIGHT,
};
pub use secret::looks_secret;
