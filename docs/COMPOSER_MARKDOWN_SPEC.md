# COMPOSER_MARKDOWN_SPEC — the composer's markdown behaviour, A–F

**What this is.** `src/components/Composer.tsx` and `src/components/Composer.test.tsx` cite
`COMPOSER_MARKDOWN_SPEC A–F` throughout their comments and `describe` blocks. Until 2026-10-12 the
spec existed only in those comments — review 33 (NIT) recorded it as "exists nowhere in the repo".
This file is that spec, written from the implementation it has always described: every rule below is
asserted by a test in `Composer.test.tsx` (named where the assertion exists) and originated in the
composer work of `Tasks/031` (T7) and `Tasks/032`.

The composer is a plain controlled `<textarea>`. Nothing here changes what is **sent**: the draft
value is raw markdown, always. Every rule below only shapes the draft while typing.

---

## A — Fence edge keys

- **Opener conversion.** Caret at the end of a ` ```lang ` opener line + **Enter** turns it into an
  open block: the key's own newline, an empty middle line, and a closing ` ``` ` follow, with the
  caret on the middle line. **Space** does the same but inserts its literal space first — a typed
  space is never swallowed into the opening newline (review 15). If a closing fence already lies at
  or after the caret, the block is already closed and only the key's own text goes in.
- A ` ``` ` line reached with an **odd** fence count above it is the *closer* of an existing block;
  leaving it never opens a new one.
- **Backtick over a selection** wraps the selection in backticks. Nothing else auto-pairs.
- **Backspace on an empty fenced block** (`` ```lang\n\n``` ``, caret on the middle line) removes the
  whole block.
- **Fence status label.** While the caret sits inside a fence, a muted hint reading
  `Code block · Ctrl+Enter to send` rides the right edge of the composer
  (`data-testid="fence-hint"`). (`describe("Composer spec A — fence status label")`.)
- **Enter inside a fence** is a plain newline that keeps the line's indent (see also C.3).
- Tests: `describe("Composer spec A — fence edge keys (COMPOSER_MARKDOWN_SPEC)")`,
  `describe("Composer spec A — fence status label")`.

## B — List mechanics

- **Newline continuation.** Caret on a list/quote line at end of line + Enter inserts the next
  marker with the same indent: `2. ` after `1. `, `- ` after `- `, `10. ` after `9. `, `> ` stays
  `> `, and a checked task item `- [x] ` continues **unchecked** (`- [ ] `).
- **Empty item finishes the list.** A marker alone on the line + Enter strips the marker line and
  exits the list *without sending*; the next Enter on the now-plain line sends.
- **Mid-line caret never fabricates an item.** Continuing only happens at the end of the line — a
  collapsed mid-line caret gets a plain newline on a list line, never a send and never a bogus
  `1. he\n2. llo` split (review 33).
- **Tab / Shift+Tab** on a list line indents / outdents the line by 2 spaces; indenting a numbered
  item restarts its marker at `1` (a nested list starts at 1, not at the parent's number). Inside a
  fence, Tab inserts 2 spaces at the caret. Outside both, Tab is plain focus traversal.
- Tests: `describe("Composer spec B — list Tab mechanics (COMPOSER_MARKDOWN_SPEC)")`.

## C — Enter priority

Enter resolves in this fixed order; the first matching rule wins:

1. **Menus first** — a slash menu open consumes Arrow/Enter/Escape (select / dismiss, no send).
2. **Ctrl+Enter (or Cmd+Enter) always sends**, regardless of `sendWith`.
3. **Inside a fence** — a newline that keeps the line indent.
4. **List continuation** (B) — end of a list/quote line continues; an empty marker exits without
   sending. Mid-line is a plain newline (B).
5. **Otherwise Enter sends** when `sendWith === "enter"`; Shift+Enter is always a plain newline.

**IME guard:** while an IME composition is in progress, no markdown chord, wrap, or send fires —
the composition owns every keypress until it ends (no `preventDefault`, no edit).

## D — Inline shortcuts

- **Ctrl+B** wraps the selection in `**`, **Ctrl+I** in `*`, **Ctrl+E** in `` ` ``.
- **Ctrl+Shift+K** fences the selection: ` ```\n<selection>\n``` ` with the caret landing on the
  language line (start + 3), preserving the draft on both sides of the selection.
- Chords are **Ctrl-only**: Alt is excluded so Alt+Space stays a system binding, and Cmd (meta) is
  accepted only where noted (C.2). No other auto-pairing exists (A).

## E — Live preview

- **Ctrl+Shift+P** toggles the preview; it is **off by default**.
- The preview is a read-only rendered pane riding above the textarea. Raw markdown stays in the
  textarea — that value is what gets sent; the preview never edits the draft.
- Test: `describe("Composer spec E — live preview")`.

## F — Paste-wrap

- **Multi-line plain text pastes as-is.** A paste is fenced only when it *looks like code*:
  every non-empty line indented 2+ spaces or a tab, **or** code characters (`{`, `}`, `;`, `=>`) on
  3+ lines. Text already containing a ` ``` ` fence passes through untouched.
- A fenced paste is wrapped as ` ```text\n<paste>\n``` ` and **spliced at the caret/selection** —
  the draft is never rebuilt from the pasted text alone (which destroyed surrounding input).
- A **"Wrapped in code block" toast** offers **Undo**: it reverts exactly that wrap (located by
  content from the paste anchor, so later edits don't detach it) and nothing else. The toast is
  non-blocking (the wrapper ignores the pointer, the Undo button does not), self-dismissing, and
  announced politely (`role="status"`).

---

**Provenance.** Ours — ORIGINAL behaviour designed for this project (no reference implementation was
copied; the rules respond to failure modes found in reviews 15 and 33). Attribution for the
vendored `Textarea` primitive it renders in lives in that file (`src/components/ui/textarea.tsx`).
