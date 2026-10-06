//! System prompt assembly and the frozen hash (D19, D39, D76).
//!
//! Assembled once at the thread's first turn, hashed into
//! `thread.system_frozen`, never rebuilt. Thinking effort, `max_tokens` and
//! `tool_choice` vary without changing the hash: they are request parameters
//! and never enter this text. Wording is ours throughout (D39) — the snapshot
//! test pins it, and any change fails there first for a conscious re-check.

use clauro_tools::ToolDefinition;

/// What the prompt is built from: tool inventory plus optional per-project
/// memory instructions. Nothing per-turn enters here (D76).
pub struct PromptInputs<'a> {
    pub tools: &'a [ToolDefinition],
    pub memory_instructions: Option<&'a str>,
}

/// Assemble the system prompt. Deterministic in the tool order given.
#[must_use]
pub fn build_system_prompt(input: &PromptInputs<'_>) -> String {
    let mut out = String::from(
        "You are Clauro, a local-first assistant. You answer from this conversation and the tools listed below. You never claim abilities the list does not give you.\n\nTools. Each entry names a tool and what it may do:\n",
    );
    for tool in input.tools {
        out.push_str("- ");
        out.push_str(&tool.name);
        out.push_str(": ");
        out.push_str(&tool.description);
        out.push('\n');
    }
    out.push_str(
        "\nFiles. The fs tool sees only the session workspace. Any path outside it is refused. Edit needs a prior read of the same path in this session; the host enforces this, not these words.\n",
    );
    out.push_str(
        "\nOutput. Long tool results reach you as a short preview plus a path you can re-read. Ask for the rest by path when the rest matters.\n",
    );
    out.push_str(
        "\nArtifacts. The artifact tool renders one self-contained document in a side drawer. Its source is HTML, and any part that needs behaviour goes in a <script type=\"text/jsx\"> block whose default export is a function returning an element tree. Inside those blocks JSX is compiled against a single helper, h(tag, props, ...children), which builds DOM nodes; there is no framework, no import, and no require. Style only with predefined utility class names: arbitrary values and invented classes have no stylesheet behind them. The artifact has no network, so nothing it writes may fetch or link anything. localStorage, sessionStorage and indexedDB are unavailable, and reading one renders a blank artifact. Each source is capped at 1 MB. Pass an existing artifactId to revise an artifact instead of starting a new one; every revision is kept as a new version.\n",
    );
    out.push_str(
        "\nMemory (/memories). The user may ask you to remember small durable notes, one topic at a time. Store only what was asked for, replace a topic instead of duplicating it, and never store secrets, credentials, or identifiers.\n",
    );
    if let Some(instructions) = input.memory_instructions {
        out.push_str("\nProject notes. ");
        out.push_str(instructions);
        if !instructions.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

/// FNV-1a over prompt text plus tool names, hex. Hand-rolled: ten lines, no
/// dependency, stable across processes and restarts (unlike a seeded
/// hasher, which would make the frozen hash unrepeatable).
#[must_use]
pub fn frozen_hash(system_text: &str, tool_names: &[&str]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in system_text
        .bytes()
        .chain(tool_names.iter().flat_map(|n| n.bytes()).chain([0]))
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// First-turn setup: the prompt and its hash together, so the caller can
/// store the hash in `thread.system_frozen` at insert time.
#[must_use]
pub fn first_turn_setup(
    tools: &[ToolDefinition],
    memory_instructions: Option<&str>,
) -> (String, String) {
    let prompt = build_system_prompt(&PromptInputs {
        tools,
        memory_instructions,
    });
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    let hash = frozen_hash(&prompt, &names);
    (prompt, hash)
}
