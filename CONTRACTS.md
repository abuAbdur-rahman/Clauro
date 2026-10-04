# Clauro — CONTRACTS.md

**The shapes every test hangs off.** `DECISIONS.md` (D1–D95) says *why*. This file says *what you can
assert against*. Nothing here is a new decision — every type traces to one.

**Rule:** if a type in this file cannot cite a D-number, it is either missing a decision or it is a
new decision wearing a type's clothes. Both are bugs.

---

## 1. Storage — SQLite

Append-only by default (**D19**). No table has an `UPDATE` path except the four marked mutable. That
is not a style preference: **D19's prefix rule only holds if history is never rewritten**, and
**D63's generation counter only means something if the surface is monotonic.**

```sql
-- ── identity ───────────────────────────────────────────────────────────────
-- Opaque IDs are authoritative paths (D32). Titles are mutable and never used
-- as identifiers, so a retitled thread does not orphan files.

CREATE TABLE project (
  id          TEXT PRIMARY KEY,          -- opaque, stable, slug-independent
  name        TEXT NOT NULL,             -- user-visible, freely mutable
  instructions TEXT NOT NULL DEFAULT '', -- Gems folded into Projects (D35)
  bash_enabled INTEGER NOT NULL DEFAULT 0,   -- (D67) the opt-in is PER PROJECT.
                                              -- Whether a given thread actually has bash is
                                              -- already recorded in thread.tools_frozen, so there
                                              -- is deliberately no per-thread copy to drift.
  created_at  INTEGER NOT NULL,
  archived_at INTEGER                    -- NULL = active
);

CREATE TABLE thread (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES project(id),   -- NULL = unprojected (D36)
  title       TEXT,                          -- mutable, never a path
  incognito   INTEGER NOT NULL DEFAULT 0,    -- (D37)
  memory_off  INTEGER NOT NULL DEFAULT 0,    -- (D8) per-chat, locks after first send

  system_frozen TEXT NOT NULL,               -- (D19) set once, first turn, never edited
  tools_frozen TEXT NOT NULL,                -- (D19) JSON array of tool names, hashed
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_thread_project ON thread(project_id, created_at DESC);

-- ── transcript: APPEND ONLY ────────────────────────────────────────────────
-- seq is per-thread monotonic and gaps are legal (a compaction removes a run).
-- surface_generation increments ONLY when a compaction is committed (D63).

CREATE TABLE message (
  id        TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id),
  seq       INTEGER NOT NULL,             -- monotonic per thread, GAPS LEGAL
  role      TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_message_seq ON message(thread_id, seq);

-- One row per content block. Blocks are never edited in place: a correction is
-- a new row at a higher seq (D19). Not one column on this table is mutable.
CREATE TABLE block (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id),
  seq        INTEGER NOT NULL,            -- position within the message
  kind       TEXT NOT NULL,               -- see §2 ContentBlock union
  payload    TEXT NOT NULL,               -- JSON, shape keyed by `kind`
  -- Compaction bookkeeping (D63)
  boundary   INTEGER,                     -- set on the block that starts the retained tail
  is_summary INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,  -- surface generation this block belongs to
  signature  TEXT,                        -- (D72) thinking signature_delta, REQUIRED for thinking
  dropped    INTEGER NOT NULL DEFAULT 0   -- (D71) set when input_transformations reports a drop
);
CREATE INDEX idx_block_msg ON block(message_id, seq);

-- ── usage: TWO CHANNELS, NEVER FOLDED (D57) ────────────────────────────────
-- summary_* is separate from the ordinary totals because a compaction call
-- re-reports the whole prefix (D13). Folding it produced the "pinned at 100%"
-- bug LibreChat had to fix, and the "reads 0/0" bug on our side (D70).

CREATE TABLE usage (
  id               TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES thread(id),
  message_id       TEXT REFERENCES message(id),
  run_id           TEXT NOT NULL,        -- a sibling run's summary is NOT ours to subtract
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  -- separate channel (D57)
  summary_tokens   INTEGER NOT NULL DEFAULT 0,
  summary_used_tokens INTEGER,            -- pre-invoke compacted size, NULL if this turn did not summarize
  -- iteration-scoped, the only source after a compaction (D70)
  iterations       TEXT,                  -- JSON: usage.iterations
  context_budget   INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_usage_thread ON usage(thread_id, created_at);

-- ── tool results: FULL OUTPUT KEPT (D27) ───────────────────────────────────
-- Bounding happens at the RETURN boundary, never at write time. The transcript
-- gets a preview plus a path; the full text stays addressable so nothing is lost.

CREATE TABLE tool_result (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES thread(id),
  tool_call_id   TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok','error','aborted','rejected')),
  preview        TEXT NOT NULL,          -- bounded, what the model sees inline
  preview_path   TEXT,                   -- file under the session workspace (D31)
  full_path      TEXT,                   -- full output, same tree
  output_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE (thread_id, tool_call_id)
);
CREATE INDEX idx_tool_result_call ON tool_result(tool_call_id);

-- ── memory: a TOPIC STORE (D7), not a conversation log ─────────────────────

CREATE TABLE memory (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id),  -- NULL = global (D35 per-project scoping)
  topic      TEXT NOT NULL,                 -- `category` is the topic (D7)
  path       TEXT NOT NULL,                 -- /memories/<path> form
  body       TEXT NOT NULL,
  sensitive  INTEGER NOT NULL DEFAULT 0,    -- (D8) opt-in, review notice on write
  revision   INTEGER NOT NULL DEFAULT 1,    -- str_replace bumps, never rewrites blind
  updated_at INTEGER NOT NULL
);
-- Uniqueness is enforced by TWO partial indexes, not a table constraint: in
-- SQLite a UNIQUE with a NULL column permits unlimited duplicates, which would
-- let global memories (project_id IS NULL, D35) accumulate the same path twice.
CREATE UNIQUE INDEX idx_memory_global_path ON memory(path) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_memory_project_path ON memory(project_id, path) WHERE project_id IS NOT NULL;

-- `thread_id` is required because a "thread" scope is meaningless without it.
-- The original `scope TEXT PRIMARY KEY` admitted exactly one row per scope value,
-- so every thread in the app shared one row and per-chat memory-off (D8) was
-- unrepresentable.
CREATE TABLE memory_setting (
  thread_id  TEXT PRIMARY KEY REFERENCES thread(id),
  paused     INTEGER NOT NULL DEFAULT 0,  -- (D8) pause keeps, stops using + writing
  include_sensitive INTEGER NOT NULL DEFAULT 0
);
-- Account-level pause lives on its own row so it cannot collide with a thread:
CREATE TABLE account_setting (
  id              INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  paused          INTEGER NOT NULL DEFAULT 0,
  include_sensitive INTEGER NOT NULL DEFAULT 0
);

-- ── attachments (D47 on disk, D52 dedupe per project) ──────────────────────

CREATE TABLE attachment (
  id         TEXT PRIMARY KEY,
  -- NULLABLE, not NOT NULL: unprojected threads exist (D36) and an unprojected
  -- thread still needs to attach a file. Dedupe scope is the project, and a
  -- global attachment dedupes against the NULL-project set.
  project_id TEXT REFERENCES project(id),
  path       TEXT NOT NULL,                -- relative to the project workspace
  content_hash TEXT NOT NULL,              -- dedupe scope is the PROJECT (D52)
  bytes      INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, content_hash)
);
-- Two partial indexes for the same NULL-distinct reason as `memory`. The
-- cross-project leak the earlier comment warned about is avoided by scoping to
-- the project, NOT by making the column NOT NULL.
CREATE UNIQUE INDEX idx_attachment_global_hash ON attachment(content_hash) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_attachment_project_hash ON attachment(project_id, content_hash) WHERE project_id IS NOT NULL;

-- ── artifacts (D1: OUR schema) ─────────────────────────────────────────────
CREATE TABLE artifact (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES thread(id),
  version       INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL,
  media_type    TEXT NOT NULL,
  source_path   TEXT NOT NULL,             -- artifacts/<artifact-id>/<version>/source
  compiled_path TEXT,                      -- written after the Worker transform
  created_at    INTEGER NOT NULL,
  UNIQUE (thread_id, id, version)
);

-- ── compaction ledger (D84) ────────────────────────────────────────────────
-- Compaction NEVER deletes. A compaction writes one row here and nothing else;
-- covered message/block rows are SUPERSEDED and stay on disk. The surface is a
-- query over this table, not a deletion. That is what makes the append-only
-- guarantee auditable: the row is still there to check the claim against.
-- `summary_tokens` / `summary_used_tokens` are D57's separate accounting channel.
CREATE TABLE compaction_event (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES thread(id),
  generation  INTEGER NOT NULL,          -- strictly +1 per committed compaction (D63)
  summary_block TEXT NOT NULL,           -- the block.id of the summary checkpoint
  covers_from INTEGER NOT NULL,          -- first superseded message.seq
  covers_to   INTEGER NOT NULL,          -- last superseded seq; surface resumes after this
  summary_tokens     INTEGER NOT NULL DEFAULT 0,
  summary_used_tokens INTEGER,           -- pre-invoke compacted size, NULL if none
  created_at  INTEGER NOT NULL,
  UNIQUE (thread_id, generation)
);
CREATE INDEX idx_compaction_thread ON compaction_event(thread_id, generation DESC);

-- SURFACE(thread) = highest-generation compaction_event's summary_block
--                + every block whose seq > that event's covers_to.
-- I3 in §2 (generation non-decreasing) is what makes this well-founded.

-- ── MUTABLE COLUMNS (everything else is append-only) ────────────────────────
-- There are **no mutable tables** — only mutable *columns*. A table is
-- append-only if every one of its columns is; `project` and `memory` are
-- therefore neither append-only nor mutable, they are mixed.
--
--   project.name, project.instructions   -- user renames a project
--   project.bash_enabled                  -- per-project opt-in (D28, D67)
--   project.archived_at                   -- soft delete
--   thread.title                          -- title is never a path (D32)
--   memory.body, memory.revision          -- str_replace bumps revision (D7)
--   memory.sensitive, memory.updated_at   -- the sensitive-topics opt-in (D8)
--   memory_setting.*                     -- pause / include_sensitive (D8)
--   artifact.compiled_path                -- set once after the Worker transform
--
-- Each has exactly one documented write path. Anything else is a bug.
-- `message` and `block` are **fully** append-only: not one mutable column.


PRAGMA journal_mode = WAL;         -- a reader never blocks the writer
PRAGMA foreign_keys = ON;          -- a dangling block is a bug, not a warning
```

**Windows path rules (D34, D79, D32).** Canonicalise, resolve symlinks and junctions **before** the
traversal check or the check is bypassable. Reject `../`, `..\`, `%2e%2e%2f`. Reject reserved device
names case-insensitively and **with any extension** — `NUL.txt` is `NUL`, and the set is
`CON PRN AUX NUL COM1–COM9 LPT1–LPT9` plus the superscript variants `COM¹²³` / `LPT¹²³`. Budget
`MAX_PATH` from the drive root, not from `~`. Opaque IDs are authoritative; slugs are cosmetic and
length-capped.

---

## 2. Content blocks — the union every view renders

One shape for both providers. **D54** requires Anthropic thinking blocks and OpenAI reasoning
tokens to normalise to the same thing; the transcript cannot branch on provider.

```ts
export type BlockKind =
  | 'text' | 'thinking' | 'tool_use' | 'tool_result'
  | 'artifact_ref' | 'question_card' | 'summary' | 'compaction'
  | 'notice';                                  // dropped-thinking, provider error (D71, D80)

export type ContentBlock =
  | { kind: 'text';          text: string }
  | { kind: 'thinking';      text: string; signature: string; display: 'full' | 'summary' }
  | { kind: 'tool_use';      id: string; name: string; input: unknown }
  | { kind: 'tool_result';   toolUseId: string; status: 'ok'|'error'|'aborted'|'rejected';
                              preview: string; previewPath?: string }
  | { kind: 'artifact_ref';  artifactId: string; version: number; title: string }
  | { kind: 'question_card'; id: string; prompt: string;
                              options?: { id: string; label: string }[];
                              allowFreeText: boolean; resolved?: string }
  | { kind: 'summary';       text: string; boundary: number; generation: number }
  | { kind: 'compaction';    providerBlockId: string }   // Anthropic only (D69)
  | { kind: 'notice';        level: 'info'|'warn'|'error'; text: string };
```

Three invariants a test can assert without any provider in the loop:

```
I1  Every tool_use has a tool_result with the same id, in the same thread.   (D61, D65)
I2  A summary's boundary >= every tool_use it covers has its result.        (D61, D18)
I3  block.generation is non-decreasing along (thread, seq).                 (D63)
```

**`thinking.signature` is not optional in practice.** A persister that stops at
`content_block_stop` replays thinking blocks that fail verification (D72). Thinking must also be an
**unbroken run** — removing one from the *middle* invalidates every later block, which is stricter
than "never re-send a removed block."

---

## 3. Tool contract

```ts
export interface ToolDefinition {
  name: string;
  description: string;        // ours, written from scratch (D39, D51)
  inputSchema: JsonSchema;    // zod-inferred; no `any` at the boundary
  writesToDisk: boolean;      // drives the consent model
}

export type ToolOutcome =
  | { status: 'ok';      preview: string; previewPath?: string; fullPath?: string }
  | { status: 'error';   message: string }        // typed, model-visible
  | { status: 'aborted'; message: string }        // cancelled by user (D65, D68)
  | { status: 'rejected'; message: string };      // user declined (D66)

// Nothing throws across this boundary (D55). A non-zero exit is `ok`.
export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<ToolOutcome>;
```

**Output bounding happens on the way out (D27).** `ok` returns a bounded `preview`; the full text is
written under the session workspace and the model is handed `previewPath` so it can re-read. Nothing
is truncated at write time and nothing is lost.

### The eight v1 tools

| Tool | `writesToDisk` | Contract notes |
|---|---|---|
| `memory` | ✅ | six commands (D7). Reject `delete`/`rename` on the root. Refuse secret-shaped writes (D43 logic). Returns are **not** a contract — the model reads whatever text we return. |
| `artifact` | ✅ | our schema (D1): `{ title, mediaType, source }`. Must fit the classifier — see §6. |
| `web-search` | ❌ | pass the current year explicitly; it is the single highest-leverage prompt line found. |
| `web-fetch` | ❌ | tool-selection heuristic: prefer another present tool that is better targeted. |
| `fs` | ✅ | rooted at the session workspace (D31, **D44 — v1 has no chosen-directory root**, so the project directory is reachable only *through* the session's own path). Anything resolving outside the workspace is refused with a typed error. **`edit` requires a prior `read` of that path this session — enforced by host state, not by a prompt** (D33). |
| `compact` | ❌ | **host-driven only, never in the request schema** (D14). Exposed as `/compact`. |
| `bash` | ✅ | off by default (D28), per-project opt-in opens a fresh thread (D67), **every** invocation approved, nothing persisted (D66). Host-owned runner: process-group kill, credential scrub, fd0 `/dev/null`, no `stdin`/`env` on the model-facing tool, env order `scrub → overrides → env → managed`. |
| `question` | ❌ | one call per assistant turn, always offers skip (D42), secret-shaped prompts refused (D43), renders **inline** (D41 — both MIT references do the opposite; this is deliberate). |

### Permission resolution

```ts
// Ported from OpenCode: whollyDisabled() → registrations.delete(name).
// The tool is REMOVED FROM THE REQUEST, not filtered from results (D26).
export type PermissionRule =
  | { effect: 'deny';  tool: string }
  | { effect: 'ask';   tool: string }
  | { effect: 'allow'; tool: string };

// Resolution is TWO STAGES, and the spec previously conflated them. Audit 4
// finding 5: stating both rules in one place left `resolve()` with no
// implementation satisfying its own description.
//
// Stage 1 — fold per effect (PORTED from OpenCode's findLast: the LAST rule
// matching a tool *within its own effect class* wins):
//   rules.filter(r => r.tool === tool)  →  last of each effect, if any
//
// Stage 2 — precedence across the three folded values (CLAURO-ORIGINAL;
// audit 2 found this ordering in neither MIT reference). Fail-closed, so a
// matching error can only ever make the outcome stricter:
//   deny present → 'deny'   |   else ask present → 'ask'   |   else 'allow'
//
// Both stages are pure and total. No branch can reach an undefined answer.
export function resolve(tool: string, rules: readonly PermissionRule[]): 'deny'|'ask'|'allow';

// Testable directly, no provider required:
//   resolve('fs',   [{ask:'fs'}, {deny:'fs'}])            === 'deny'   // stage 2
//   resolve('fs',   [{deny:'fs'}, {ask:'fs'}])            === 'deny'   // order irrelevant
//   resolve('bash', [{allow:'bash'}, {deny:'bash'}])      === 'deny'   // fail-closed
//   resolve('fs',   [{allow:'fs'}, {ask:'fs'}])           === 'ask'    // allow+ask -> ask
//   resolve('fs',   [{allow:'fs'}, {allow:'fs'}])         === 'allow'  // stage 1, last wins
//   resolve('fs',   [{deny:'bash'}])                      === 'allow'  // no match -> default
export const DEFAULT_EFFECT: 'allow' = 'allow';
```

---

### Secret-shaped input — the guard, defined

`D43` requires the `question` tool and the `memory` tool to refuse secret-shaped input. "Secret-shaped"
must be a predicate, not a judgement call, so it is one and it is testable:

```ts
export type SecretVerdict = 'refuse' | 'allow';

// Refuse: government ID numbers, financial account numbers, criminal-history
// and immigration-status statements, and anything that looks like a live key
// or token. Matches the categories the first-party memory tool itself declines.
export function looksSecret(s: string): boolean;
```

Rules: PEM/PRIVATE KEY headers · `sk-`/`ghp_`/`xox[baprs]-`/`AKIA` prefixes ·
`ghp_`/`github_pat_` · long high-entropy base64/hex runs ≥ 32 chars with no spaces ·
`\d{3}-\d{2}-\d{4}` (SSN) · 13–19 digit runs with optional separators (card/IBAN) ·
the words `passphrase`/`private key` adjacent to an assignment.

Refusal is **silent to the model** — the tool returns a typed `error` result and nothing else, so a
model cannot learn the shape of the guard by probing it. Test: a table of real-shaped samples, each
asserting `'refuse'`, plus benign look-alikes (`sk-` inside a word, a 32-char hex git SHA) asserting
`'allow'`, because a guard that refuses a commit hash is a guard people will turn off.

## 4. Token meter

**D25** deliberately separates accounting from policy, which *creates* an interface that must exist.
A test can mock this and assert compaction behaviour without a provider.

```ts
export interface TokenMeter {
  /** Measure the exact surface that would be sent. */
  measure(surface: ReadonlyArray<ContentBlock>, sys: SystemParts): Measurement;
}

export interface Measurement {
  inputTokens: number;
  reserved: number;        // max(maxOutputTokens, buffer)      (D64)
  headroomTokens: number;  // from the model policy
  usableTokens: number;    // contextWindow − reserved − headroomTokens
  ratioBound: number;      // 0.8 × contextWindow
  triggerTokens: number;   // min(ratioBound, usableTokens)     (D64, audit 2)
  contextWindow: number;
}
```

```
trigger = min(0.8 × contextWindow, (contextWindow − max(maxOutputTokens, buffer)) − headroom)
```

Both bounds, because both failure modes are real: a large-output model on a modest window overflows
before a ratio fires, and an over-eager bound compacts constantly. DeepSeek already takes the `min`;
we keep both.

**Policy receives intent, never arithmetic (D25).**

```ts
export interface CompactionPolicy {
  compactIfNeeded(trigger: 'pressure' | 'context-overflow'): Promise<CompactionResult | null>;
}

export type CompactionResult =
  | { kind: 'committed'; generation: number }   // the ONLY thing that authorises a retry (D63)
  | { kind: 'pruned';    generation: number }    // pruning alone can be enough (D81)
  | { kind: 'no-progress' };                     // NOT a success (D63, D17)
```

`no-progress` exists so "the summariser returned but changed nothing" is representable. **Without it,
D17's anti-thrash breaker is a heuristic; with it, it is enforceable.**

---

## 5. Provider adapters

Two adapters (D48): Anthropic, and one OpenAI-compatible adapter for everything else. The transcript
never branches on provider.

```ts
export interface ProviderAdapter {
  readonly id: 'anthropic' | 'openai-compatible';

  /** Resolve limits. Static for the UI; a live snapshot overrides it at runtime.
   *  Shape confirmed independently by OpenCode and LibreChat (D23). */
  limits(model: ModelRef): ModelLimits;

  /** Runtime capability probe. No live key needed to decide (D75, D81). */
  capabilities(model: ModelRef): Promise<{
    compaction: 'threshold' | 'on-demand' | 'none';
    thinkingEffort: boolean;
  }>;

  /** Build a request. MUST honour the XOR in D21 and the fixed system+tools in D19. */
  build(req: BuildRequest): ProviderRequest;

  /** One normalised event per provider event. Unknown events do not throw (D80). */
  parse(event: RawSseEvent): NormalisedEvent[];
}

export type NormalisedEvent =
  | { t: 'block_start';  index: number; kind: BlockKind }
  | { t: 'block_delta';  index: number; text?: string; signature?: string }  // D72, D73
  | { t: 'block_stop';   index: number }
  | { t: 'usage';        u: UsageWire }                                     // D57, D70
  | { t: 'input_transformed'; dropped: number }                              // D71
  | { t: 'stop';         reason: StopReason }
  | { t: 'ping' }
  | { t: 'error';        message: string }
  | { t: 'ignored';      rawType: string };   // D80 — fail OPEN on the stream
```

**Four parser rules that are easy to get wrong and cheap to assert:**

```
P1  An unrecognised event is `ignored`, never fatal.      (D80)
P2  A signature_delta is captured even if the block renders as empty.
    thinking.display:"omitted" sends exactly one EMPTY thinking_delta
    then one signature_delta.                              (D72, D73)
P3  input_transformations is read on message_start AND on the final
    message_delta; it is the only runtime signal of a drop. (D71)
P4  Usage comes from usage.iterations, never from the top-level
    fields. Sum every iteration for billing; take the LAST for
    context size. Top-level is zero for a compaction-only
    response but non-zero (and meaning something else) under
    threshold compaction.                              (D70)
```

P4 is the one that silently ships: a usage footer that reads 0/0 looks like a bug in the meter, not
a protocol detail.

---

## 6. Acceptance criteria for §3 (v1 scope)

§3 of DECISIONS.md lists what is in v1 but never defines *done*. This is the definition.

**Shell**
- [ ] Cold start performs **zero network calls to any model provider or third-party host** until the
      user sends a message. The single exception is the WebView2 runtime check on Windows, which is
      OS-vendor infrastructure and only on first run (`D49`, `D53`). A test asserts that no request
      leaves the machine to any host other than the one already configured, from process start to
      first send.
- [ ] API key read from the OS keychain; never written to SQLite, never logged.
- [ ] `models.dev` fetched once and cached; **never bundled** (D23). An unknown model degrades to a
      typed notice, not a crash.
- [ ] Binary ≤ ~25 MB.

**Transcript**
- [ ] A cancelled turn leaves every dispatched call closed (D65) and keeps completed work (D68).
- [ ] Reasoning renders as one collapsible inline region, one shape, both providers (D54).
- [ ] Incognito: a thread flagged incognito never appears in history, search, or memory (D37).

**Tools**
- [ ] All eight registered; `compact` absent from the request schema and reachable only as `/compact` (D14).
- [ ] `fs` refuses any path outside the session workspace with a typed error (D31, D44).
- [ ] `fs.edit` errors without a prior `read` of that path this session, enforced by host state (D33).
- [ ] `bash` is off by default; enabling opens a fresh thread; every command is individually approved
      and nothing is persisted (D28, D66, D67).
- [ ] `question` is capped at one per assistant turn, always offers skip, and refuses secret-shaped
      prompts (D42, D43).

**Artifacts**
- [ ] The iframe's `contentWindow` has **no** reachable path to Tauri internals (D2).
- [ ] A denied network request from inside an artifact fails (D3).
- [ ] An artifact that throws does not take down the host UI (D4 — Worker + timeout + size cap).
- [ ] **If WebKitGTK cannot hold an opaque origin, artifacts are disabled at runtime on Linux with a
      notice naming the reason** (D45). The build is one package; the gate is a runtime check.

**Compaction**
- [ ] Compaction fires on `min(0.8 × window, usable − headroom)` (D64).
- [ ] A summariser that changes nothing yields `no-progress` and cannot authorise a retry (D63).
- [ ] Usage after compaction is read from `usage.iterations`, not the zeroed top-level fields (D70).
- [ ] The summary call is a prefix extension: identical leading tokens, one trailing instruction,
      `tools` carried through (D13).
- [ ] No assistant `tool_use` is ever separated from its result across a compaction (D61, D18).

**The one spike that gates all of it:** dual-engine sandbox verification (Windows WebView2 +
Linux WebKitGTK). No document answers it. **Do this first** — it can invalidate D45, and D45 is a
release gate.

---

## 7. Test seams that fall out of these contracts

Every one of these is assertable with no provider, no network, and no webview:

| Contract | The test that hangs off it |
|---|---|
| §1 append-only | mutate any non-mutable table → assert the write path is absent |
| §2 invariants I1–I3 | run any transcript through a fixture and assert pairing, boundary, monotonicity |
| §3 `ToolOutcome` | every tool returns a discriminated result; **nothing throws** (D55) |
| §3 permission `resolve` | `deny` wins over `allow` regardless of order; most recent rule wins |
| §3 output bounding | full output survives, preview is bounded, `previewPath` re-reads identically (D27) |
| §4 `Measurement` | `triggerTokens` equals the `min` for a matrix of window/output/headroom values (D64) |
| §4 `no-progress` | a summariser returning identical text cannot authorise a retry (D63) |
| §5 P1–P4 | feed raw SSE fixtures for omitted thinking, a compaction response, an unknown event, and a dropped block |