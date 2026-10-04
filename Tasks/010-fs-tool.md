# Task 010 — `fs` tool

**Phase** 2 · **Depends** `007` · **Decisions** D31, D32, D33, D34, D44, D79
**Contracts** §3

**Scheduled after `008`/`009` and before `012 bash` on purpose** — this task is what proves the
workspace tree is safe. `bash` is the largest blast radius in the product and must not be the first
thing written against that tree.

## Failing tests first

- `edit` on a path not `read` this session → `error`, file unchanged
- `edit` after `read` → succeeds
- `read`/`glob`/`grep` outside the session workspace but inside the project → allowed
- `write` outside both → refused
- A path containing `../` → refused
- A **symlink inside the tree pointing outside it** → refused
- On Windows: `NUL.txt`, `com1`, `COM¹` → all refused
- A path exceeding the `MAX_PATH` budget from the drive root → refused

## Do

**Rooted at a Clauro-owned tree** (`~/.clauros/`, or `$CLAURO_DATA_DIR` / `XDG_DATA_HOME`):

```
projects/<project-id>-<slug>/sessions/<session-id>-<slug>/
  attachments/              copied in on upload, deduped per project
  artifacts/<artifact-id>/
sessions/<session-id>-<slug>/                      no project
```

`read`/`glob`/`grep` may also take the project directory. Everything else is refused with a typed
error. `D31`.

**No chosen-directory root in v1** (`D44`). A project never points at a path the user picked. The
containment guarantee is true on day one. `attach` — copy a directory in, sync back on demand — is
**designed but not built**, first thing to add if `fs` proves too confined. *Adding an escape hatch
later is cheap. Retracting a security promise later is not.*

**Opaque IDs authoritative; slugs cosmetic and capped** (`D32`). An AI-generated title is not a safe
path component — separators, `..`, reserved names, duplicates, and it regenerates. The human title
lives in SQLite.

**Path safety order is load-bearing** (`D34`, `D79`):
1. canonicalise
2. **resolve symlinks and junctions**
3. **then** the traversal check

Checking traversal before resolving is bypassable. Reject `../`, `..\`, `%2e%2e%2f`. Windows
reserved names case-insensitively **and with any extension** — `NUL.txt` is `NUL`. Set:
`CON PRN AUX NUL COM1–COM9 LPT1–LPT9` plus `COM¹²³` / `LPT¹²³`.

**Preconditions are host state, not prompt text** (`D33`). Track reads per `(session, path)`.
`edit` errors unless that path was read this session. **A prompt is advisory.** Every `fs` rule lives
in Rust.

**All prompts written from scratch** (`D39`). OpenCode's `read`/`edit` prompts contain first-party
proprietary wording verbatim inside an MIT repo — MIT cannot relicense it. Borrow the behaviour
(2000-line default, `offset`, 2000-char line truncation, unique-match failure reporting, `replaceAll`
for renames); **none of the wording**.

## Acceptance criteria

- [ ] Read-before-edit enforced by host state
- [ ] Project dir readable; nothing beyond it writable
- [ ] Traversal, symlink escape, and Windows reserved names all rejected
- [ ] Opaque IDs authoritative; a retitled thread does not orphan files
- [ ] **Upload copies into the session workspace** (`attachments/`), never references the original path
- [ ] The model is given path + size + media type only — never the file's bytes inline (**D47**)
- [ ] Dedupe is per project: same file twice in one project → one copy; same file in two projects →
      two copies (**D52**)
- [ ] A Windows upload whose name is a reserved device name is renamed, not rejected — the user chose
      that file and deserves it to work (**D79**)
- [ ] Windows DACL semantics followed; staging inside `dirname(target)`, never `%TEMP%`
- [ ] No prompt text overlaps any reference implementation
