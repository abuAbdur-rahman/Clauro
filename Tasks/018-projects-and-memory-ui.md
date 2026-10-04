# Task 018 — Projects and the memory UI

**Phase** 5 · **Depends** `008` · **Decisions** D8, D9, D35, D36, D37, D52
**Contracts** §1, §2

## Failing tests first

- Project A's memory is invisible to project B, **both directions**
- Renaming a project **does not orphan files** — the opaque ID is authoritative
- A thread started with memory-off writes nothing **and** reads nothing
- That thread's memory setting **locks after the first send**
- Attachment dedupe: the same file in project A and project B → **two copies**
- The same file twice in project A → **one copy**
- Pause does not backfill on resume
- Reset removes project memories too

## Do

**Projects are the scoping primitive**, not a folder of chats. Each project has a name, an
instruction block, **its own memory space**, its own files, and its own workspace directory. Per-project
memory isolation is what makes memory useful rather than a flat notepad — it is the load-bearing idea
behind the whole of `008`. `D35`.

**Gems are folded into Projects** (`D35`). The first-party product has both "Projects" and "Gems"
(named reusable assistants with instructions and attached files). One concept here: the project *is*
the persona. Fewer concepts to learn; and a Gems-style feature that duplicates the scoping primitive
would split memory across two namespaces.

**Threading and attachments are per-project** (`D36`).

**Four distinct memory controls, never collapsed** (`D8`):
- account **pause** — keeps memory, stops using, stops writing, **not backfilled** on resume
- account **reset** — permanent, irreversible, **includes project memories**
- per-thread **off** — set before the first message, **locks after** `D9`
- **sensitive topics** — off by default, review notice above the composer on every save

**Absence as signal** (`D9`): a crossed-out memory icon beside the chat title when memory is off, and
**no icon at all** when it is on. No extra chrome, and the state is unmissable.

**Dedupe is per project** (`D52`): `UNIQUE (project_id, content_hash)`. **Never globally unique** —
global content-addressing makes one project observable referencing a file another supplied.

**Renaming must not move files.** `D32`: the opaque ID is authoritative, slugs are cosmetic. A title
is not a path — it contains separators, `..`, reserved names, duplicates, and regenerates.

## Acceptance criteria

- [ ] Project memory isolation, both directions
- [ ] Rename moves no files
- [ ] Per-thread memory-off: no writes, no reads, locked after first send
- [ ] Crossed-out icon when off, nothing when on
- [ ] Four controls are four distinct behaviours
- [ ] Pause does not backfill; reset clears project memories
- [ ] Dedupe per project, never global
- [ ] Instructions block reaches the system prompt as part of the frozen `system`
