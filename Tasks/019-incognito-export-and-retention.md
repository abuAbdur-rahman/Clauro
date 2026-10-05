# Task 019 — Incognito, export, and retention

**Phase** 5 · **Depends** `004` · **Decisions** D19, D37, D38, D57, D67, D99 · **Contracts** §1

## Failing tests first

- An incognito thread **never** appears in history, search, or memory
- Export of an incognito thread is impossible from the UI
- Fork of an incognito thread is impossible from the UI (**D99**)
- Fork copies the thread's prefix rows into a new thread under new ids; the source rows are byte-identical after (**D99**)
- Thread export → HTML and Markdown, both readable
- Memory export → JSON, round-trips
- **Thread export strips thinking blocks** — they are account-bound on current models and a
  re-import would fail verification
- Export contains **no API key material**
- Deleting a chat leaves its memories `D10` — stated plainly in the UI

## Do

**Incognito** (`D37`): the ghost icon on a new chat. The thread is excluded from history, from search,
and from memory. It is the **only feature available with nothing configured**, and the highest
trust-per-line in the entire feature set — roughly fifteen lines of code for the thing users
actually notice first about a local-first client.

**Export** (`Phase 4` scope): thread → HTML / Markdown, memory → JSON.

> **Strip thinking blocks on export.** They are bound to the account on current models, so an
> exported file carrying them would replay as invalid on any other account. A user who exports a
> thread and re-imports it three weeks later, on a different key, gets a failure they cannot diagnose.
> Export the reasoning as **plain text**, if at all.

**Retention is a stated behaviour, not a side effect.** `D57`: memory **outlives** its source
conversation. Deleting a chat does not delete memories derived from it — that is the point of memory,
and it is adopted knowingly (`D10`). The UI must say so, because a user who deletes a conversation
expects deletion.

**Zero telemetry** (`D38`). No analytics, no crash reporting, no usage ping — not opt-in, not
gated, **absent**. Local file logs only, at a level the user controls. The reference implementations
made telemetry opt-in *by build and environment variable*; we ship none at all, so the guarantee does
not depend on how the binary was compiled.

## Acceptance criteria

- [ ] Incognito excluded from history, search, memory
- [ ] Incognito unexportable from the UI
- [ ] Incognito unforkable from the UI (**D99**)
- [ ] Fork carries the prefix into a new thread; source history untouched (**D99**)
- [ ] Thread export → HTML and Markdown
- [ ] Memory export → JSON, round-trips
- [ ] **Thinking blocks stripped on export**
- [ ] No key material in any export
- [ ] Deleting a chat leaves memories, and the UI says so
- [ ] No telemetry path exists anywhere in the binary

### Deleting every byte — this discharges MISSION's strongest privacy claim

Export and delete are different verbs. Export is already covered above; **deletion is not, and it is
the claim the product is built on.** These are destructive, so they need criteria, not intent.

- [ ] Deleting a thread removes its `message` and `block` rows, its `usage` rows, and its
      `tool_result` rows
- [ ] Deleting a thread **deletes the files on disk too** — the session workspace directory, including
      every `full_path` tool output, not just the bounded preview. A row deleted with its file left
      behind is not a delete.
- [ ] Deleting a project removes its threads, its memories, its attachments, its artifacts, and the
      whole `projects/<id>-*/` subtree
- [ ] Deleting memory entries removes the rows. Memory survives thread deletion **by design** (D10) —
      so "delete every byte" means an explicit, separately-confirmed memory purge, and the UI must
      say plainly that deleting a chat does *not* delete what memory learned from it
- [ ] Destructive actions confirm, name what will be destroyed, and cannot be silently triggered by
      an artifact, a tool, or a prompt
- [ ] **Test:** after deleting a project, `sqlite3` reports zero rows for its ids, and a recursive
      walk of `~/.clauros/` finds no directory or file under its id. This is asserted against the real
      filesystem, not against a mock
- [ ] Export-then-delete round-trips: what export produced, delete removes
