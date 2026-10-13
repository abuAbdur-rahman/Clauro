/**
 * Composer shell (Task 027, polished Task 031 T7). Textarea plus the footer
 * action row: attach, memory toggle, thinking-effort select, provider-grouped
 * model picker, disabled voice, send/stop, live token estimate, slash-command
 * menu, and markdown wrap keys.
 *
 * Icon-only buttons carry no visible text: the tooltip carries the TEXT label
 * (memory on/off, web search, thinking level, send/stop). Hints ride
 * text-muted-foreground, whose light/dark values clear the 4.5:1 floor
 * (pinned by contrast.test.ts, not by a ramp class).
 *
 * Send is a callback prop — no turn loop exists yet (023 owns dispatch), so
 * the shell collects intent and hands it off. Voice renders disabled with
 * its reason: no voice, DESIGN.md §6.
 *
 * Suggestion chips live with the home surface (HomeGreeting), not here:
 * App/HomeGreeting are under another hand, so this file stays chip-free.
 */
import {
  ArrowUpIcon,
  BrainIcon,
  EyeIcon,
  GlobeIcon,
  MicIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useThreadStore, type Effort } from "../features/catalogue/thread";
import { Markdown } from "../features/transcript/TranscriptView";
import ModelPicker from "./ModelPicker";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const EFFORTS: { value: Effort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const SLASH_COMMANDS: { name: string; hint: string }[] = [
  { name: "new", hint: "Start a new chat" },
  { name: "compact", hint: "Compact the conversation" },
  { name: "model", hint: "Choose a model" },
  { name: "clear", hint: "Clear messages" },
  { name: "memory", hint: "Open memory settings" },
  { name: "settings", hint: "Open settings" },
];

const FENCE_RE = /^```([A-Za-z0-9+#_-]*)\s*$/;

/** How long the paste-wrap undo toast lingers before it dismisses itself. */
const PASTE_TOAST_MS = 6000;

/** A paste the composer fenced on its own, kept so Undo can revert it. */
type PasteWrap = {
  /** The ```` ```text … ``` ```` block that was spliced in. */
  fenced: string;
  /** The raw clipboard text as it arrived, for the revert. */
  raw: string;
  /** Where the paste landed — the Undo splice anchor. */
  start: number;
};

/**
 * Fence-opener language for a full line, or null when the line is not an
 * opener. `""` = bare fence (renders as text). Anything outside the allowlist
 * stays literal text — never a block, never a throw.
 */
export function fenceLanguage(line: string): string | null {
  const m = line.match(FENCE_RE);
  return m ? m[1] : null;
}

/** Odd fence count before the caret = the caret sits inside an open fence.
 *  Lines that look like an opener but fail the language allowlist (e.g.
 *  ` ```<img> `) are literal text and never count — Enter there sends. */
export function isInsideFence(text: string, caret: number): boolean {
  let n = 0;
  for (const line of text.slice(0, caret).split("\n")) {
    const marks = line.match(/```/g) ?? [];
    if (marks.length === 0) continue;
    if (/^\s*```/.test(line) && fenceLanguage(line.trim()) === null) continue;
    n += marks.length;
  }
  return n % 2 === 1;
}

/** A closing ``` line already lies at or after the caret. */
function hasClosingFenceAhead(after: string): boolean {
  return /(^|\n)```[ \t]*(\n|$)/.test(after);
}

const LIST_RE = /^(\s*)(?:(>)|([-*+])(?:\s(\[[ x]\]))?|(\d+)([.)]))\s/;

/**
 * List continuation for a newline keypress (COMPOSER_MARKDOWN_SPEC B): caret
 * on a list/quote line + newline → next marker with the same indent
 * (`2. ` after `1. `, `- ` after `- `, `10. ` after `9. `, `- [x] ` →
 * unchecked `- [ ] `, `> ` stays `> `). An empty item (marker alone)
 * finishes the list — the marker line is stripped so the caller exits the
 * list without sending. Null when the line is not a list item.
 */
export function continueList(
  draft: string,
  caret: number,
): { kind: "continued" | "finished"; text: string; caret: number } | null {
  const lineStart = draft.lastIndexOf("\n", caret - 1) + 1;
  const lineEndRel = draft.indexOf("\n", caret);
  const lineEnd = lineEndRel === -1 ? draft.length : lineEndRel;
  const line = draft.slice(lineStart, lineEnd);
  const m = line.match(LIST_RE);
  if (m === null) return null;
  // (noUncheckedIndexedAccess is off: groups type as string, so narrow
  // through explicitly-undefined locals instead of ?? / !== undefined.)
  const indent: string = m[1];
  const quote = m[2] as string | undefined;
  const bullet = m[3] as string | undefined;
  const task = m[4] as string | undefined;
  const num = m[5] as string | undefined;
  const delim = m[6] as string | undefined;
  let marker: string;
  let next: string;
  if (quote !== undefined) {
    marker = quote;
    next = "> ";
  } else if (bullet !== undefined) {
    marker = task !== undefined ? `${bullet} ${task}` : bullet;
    next = task !== undefined ? "- [ ] " : `${bullet} `;
  } else if (num !== undefined && delim !== undefined) {
    marker = `${num}${delim}`;
    next = `${String(Number(num) + 1)}${delim} `;
  } else {
    return null;
  }
  if (line.trim() === marker) {
    // Marker alone: finish — strip the marker line, exit the list, no send.
    return { kind: "finished", text: draft.slice(0, lineStart) + draft.slice(lineEnd), caret: lineStart };
  }
  const insert = `\n${indent}${next}`;
  return {
    kind: "continued",
    text: draft.slice(0, caret) + insert + draft.slice(caret),
    caret: caret + insert.length,
  };
}

/**
 * `clauro.prefs.sendWith` (Settings → General) — the composer is its only
 * reader. Anything but a stored `"ctrl"` means Enter sends, matching the
 * unswitched default. Private-mode storage throws: fall back silently, the
 * pref is a convenience, not a dependency.
 */
function readSendWithPref(): "enter" | "ctrl" {
  try {
    return window.localStorage.getItem("clauro.prefs.sendWith") === "ctrl" ? "ctrl" : "enter";
  } catch {
    return "enter";
  }
}

export default function Composer({
  threadId,
  memoryOff,
  sendWith,
  running = false,
  onSend,
  onStop = () => {},
  onAttach,
  onMemoryToggle,
  onCompact = () => {},
  onSlashCommand,
}: {
  threadId: string;
  /** Controlled memory state; 008/018 own the source of truth. */
  memoryOff?: boolean;
  /** Enter-to-send vs Ctrl+Enter-to-send. A prop (not the settings store):
   *  it wins when given; without it the composer reads `clauro.prefs.sendWith`
   *  itself (the composer is that key's only reader, review 30 owner TODO). */
  sendWith?: "enter" | "ctrl";
  /** A turn is streaming: send swaps for stop in place, typing stays on. */
  running?: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  /** Files picked through the hidden input. Absent = attach stays disabled
   *  with its reason (never a silent noop). */
  onAttach?: (files: File[]) => void;
  onMemoryToggle?: () => void;
  /** /compact lands here as a noop default — the real binding is 023's. */
  onCompact?: () => void;
  onSlashCommand?: (command: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(
    // Restored on mount: review 30's composerDrafts survives an unmount.
    () => useThreadStore.getState().composerDraft(threadId) ?? "",
  );
  const [composing, setComposing] = useState(false);
  // Caret mirror for the fence hint: updated on input/keyup/select so the
  // "Code block" label tracks where the caret actually is.
  const [caret, setCaret] = useState(0);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashOff, setSlashOff] = useState(false);
  // Web search is composer-local request-parameter state (031 T7): visual
  // only, no wire shape changes. On by default per the html reference.
  const [webOn, setWebOn] = useState(true);
  // Live preview (spec E): off by default; a read-only rendered pane rides
  // above the textarea. Raw markdown stays in the textarea — that is sent.
  const [previewOn, setPreviewOn] = useState(false);
  // Paste-wrap toast (spec F): set when the paste handler fenced a code-like
  // paste; Undo reverts that specific wrap without touching the rest of the
  // draft. Null when no wrap is pending.
  const [pasteWrap, setPasteWrap] = useState<PasteWrap | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const effort = useThreadStore((s) => s.threads[threadId]?.effort ?? "medium");
  const setEffort = useThreadStore((s) => s.setEffort);
  const empty = draft.trim() === "";
  // Desired caret after a programmatic markdown edit (see the layout effect).
  const pendingSel = useRef<number | null>(null);
  // Per-thread draft (review 30): `composerDrafts` is the record. One effect
  // does both directions — on a thread switch the stored value wins over the
  // previous thread's text (the stale text must never land in this thread),
  // on a local edit it writes through. A blank draft deletes the key, so a
  // sent message does not resurrect as a draft later.
  const loadedFor = useRef<string | null>(null);
  // Mirror of the live draft for the store subscription below. Declared
  // before the write-through effect: effects run in declaration order, so
  // the ref is already fresh when the write-through fires the store and the
  // subscriber sees own writes as equal (no-op) instead of adopting them.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    if (loadedFor.current !== threadId) {
      loadedFor.current = threadId;
      setDraft(useThreadStore.getState().composerDraft(threadId) ?? "");
      setCaret(0);
      setPasteWrap(null);
      return;
    }
    useThreadStore.getState().setComposerDraft(threadId, draft);
  }, [threadId, draft]);
  // External adoption (review 30): App's suggestion fill is a plain
  // `setComposerDraft`, so a mounted composer follows the store when
  // something other than its own write-through changes the record. An absent
  // key is "no draft", never a reason to clear typed text.
  useEffect(() => {
    return useThreadStore.subscribe((s) => {
      const stored = s.composerDraft(threadId);
      if (stored !== null && loadedFor.current === threadId && stored !== draftRef.current) {
        draftRef.current = stored;
        setDraft(stored);
      }
    });
  }, [threadId]);
  // The pref is the prop's fallback (prop wins), read per render: Settings
  // may rewrite it while this composer is open.
  const sendMode: "enter" | "ctrl" = sendWith ?? readSendWithPref();

  function setCaretTo(at: number) {
    pendingSel.current = at;
    setCaret(at);
  }

  // Re-apply the caret after a markdown edit commits a new value into the
  // controlled textarea. A layout effect keyed on the value itself: React has
  // already written the DOM value, so selection positions set here survive
  // (the browser resets selection when it replaces value in the commit phase,
  // which is why an ordinary effect loses the race). Guarded to edits made
  // through setCaretTo so the browser's own caret advance on plain typing is
  // never stomped.
  useLayoutEffect(() => {
    if (pendingSel.current === null || taRef.current === null) return;
    const at = pendingSel.current;
    pendingSel.current = null;
    taRef.current.selectionStart = at;
    taRef.current.selectionEnd = at;
  }, [draft]);

  function send() {
    if (running) return;
    const text = draft.trim();
    if (text === "") return;
    onSend(text);
    setDraft("");
    setCaret(0);
    setSlashIdx(0);
  }

  function pickFiles() {
    fileRef.current?.click();
  }

  function onFilesChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    // Reset so picking the same file twice still fires a change.
    e.target.value = "";
    if (files.length > 0) onAttach?.(files);
  }

  function runSlash(command: string) {
    setSlashIdx(0);
    setSlashOff(false);
    // A command dispatched nowhere must not destroy the typed draft (review
    // 30): clear it only when something actually handles the command —
    // /compact always, the rest only when a caller owns onSlashCommand.
    if (command !== "compact" && onSlashCommand === undefined) {
      setSlashOff(true); // acknowledge the keypress without eating input
      return;
    }
    setDraft("");
    if (command === "compact") onCompact();
    onSlashCommand?.(command);
  }

  function wrapSelection(prefix: string, suffix?: string) {
    const el = taRef.current;
    if (el === null) return;
    const suf = suffix ?? prefix;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const next = draft.slice(0, s) + prefix + draft.slice(s, e) + suf + draft.slice(e);
    setDraft(next);
    setCaretTo(s + prefix.length);
  }

  const slashQuery = draft.match(/^\/(\w*)$/)?.[1].toLowerCase();
  const slashItems =
    slashQuery === undefined || slashOff
      ? null
      : SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery));

  // The filter text drives the list; the highlight resets with it, and a
  // dismissed menu reopens on the next edit.
  useEffect(() => {
    setSlashIdx(0);
    setSlashOff(false);
  }, [slashQuery]);

  // The paste-wrap toast dismisses itself; the timer is created per toast
  // and cleared in the teardown (toast gone or component unmounted), so no
  // timer outlives the thing it updates.
  useEffect(() => {
    if (pasteWrap === null) return;
    const timer = window.setTimeout(() => {
      setPasteWrap(null);
    }, PASTE_TOAST_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pasteWrap]);

  /** Revert one specific fenced paste-wrap, leaving every other edit alone. */
  function undoPasteWrap(wrap: PasteWrap) {
    setPasteWrap(null);
    // Locate the fenced block by content from the paste anchor: edits made
    // AFTER the paste shift positions, but the block itself is still there.
    const at = draft.indexOf(wrap.fenced, wrap.start);
    if (at === -1) return; // edited beyond recognition — nothing left to revert
    const next = draft.slice(0, at) + wrap.raw + draft.slice(at + wrap.fenced.length);
    setDraft(next);
    setCaretTo(at + wrap.raw.length);
  }

  /**
   * Fence opener (COMPOSER_MARKDOWN_SPEC A): caret at the end of a ```lang
   * line + Enter/Space converts to an open block. `insertText` is the
   * character the triggering key itself inserts — Enter's "\n", Space's
   * " " (review 15: a typed space is never swallowed into the opening
   * newline). A closing fence ahead means the block is already closed, so
   * only the key's own text goes in; otherwise an empty middle line and a
   * closing fence follow, cursor on the middle line. A ``` line reached
   * with an odd fence count above it is the CLOSER of an existing block —
   * leaving it, not opening a new one. Returns true when handled.
   */
  function openFence(el: HTMLTextAreaElement, insertText: string): boolean {
    const caret = el.selectionStart;
    if (el.selectionEnd !== caret) return false;
    const lineStart = draft.lastIndexOf("\n", caret - 1) + 1;
    if (isInsideFence(draft, lineStart)) return false;
    if (fenceLanguage(draft.slice(lineStart, caret)) === null) return false;
    // Close ahead: block already closed — the key's text alone.
    if (hasClosingFenceAhead(draft.slice(caret))) {
      const closed = draft.slice(0, caret) + insertText + draft.slice(caret);
      setDraft(closed);
      setCaretTo(caret + insertText.length);
      return true;
    }
    // No close ahead: key text + empty middle line + closing fence.
    // Enter's newline is itself the opener line's end; a space is followed
    // by one.
    const opener = insertText === "\n" ? "\n" : `${insertText}\n`;
    const next = draft.slice(0, caret) + `${opener}\n\`\`\`` + draft.slice(caret);
    setDraft(next);
    setCaretTo(caret + opener.length);
    return true;
  }

  /** Leading whitespace of the line containing the caret (fence indent). */
  function lineIndent(caret: number): string {
    const lineStart = draft.lastIndexOf("\n", caret - 1) + 1;
    const m = draft.slice(lineStart, caret).match(/^[ \t]*/);
    return m === null ? "" : m[0];
  }

  /** Tab/Shift+Tab: fence → indent spaces; list line → indent/outdent. */
  function handleTab(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    const el = e.currentTarget;
    const caret = el.selectionStart;
    const inside = isInsideFence(draft, caret);
    const lineStart = draft.lastIndexOf("\n", caret - 1) + 1;
    const lineEndRel = draft.indexOf("\n", caret);
    const lineEnd = lineEndRel === -1 ? draft.length : lineEndRel;
    const line = draft.slice(lineStart, lineEnd);
    const isList = line.match(LIST_RE) !== null;
    if (!inside && !isList) return false; // plain Tab: focus traversal
    e.preventDefault();
    if (!e.shiftKey) {
      // Fence: 2 spaces at the caret. List: indent the line 2 spaces and
      // restart a numbered marker at 1 (spec B).
      if (inside) {
        const next = draft.slice(0, caret) + "  " + draft.slice(el.selectionEnd);
        setDraft(next);
        setCaretTo(caret + 2);
      } else {
        const indented = `  ${line.replace(/^(\d+)([.)])/, "1$2")}`;
        const next = draft.slice(0, lineStart) + indented + draft.slice(lineEnd);
        setDraft(next);
        setCaretTo(lineStart + indented.length);
      }
    } else {
      // Outdent: strip up to 2 leading spaces of the current line.
      const lead = line.match(/^ +/);
      const strip = Math.min(2, lead === null ? 0 : lead[0].length);
      const next = draft.slice(0, lineStart) + line.slice(strip) + draft.slice(lineEnd);
      setDraft(next);
      setCaretTo(Math.max(lineStart, caret - strip));
    }
    return true;
  }

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // An IME composition owns every keypress until it ends: a markdown chord
    // fired mid-composition would wrap or fence the in-progress composition
    // text (review 15). No preventDefault, no edit — the IME keeps the key.
    if (composing) return;
    const el = e.currentTarget;
    const caret = el.selectionStart;

    // Spec D: inline shortcuts. Ctrl+Shift+K puts the caret on the language
    // line of a fresh fenced block around the selection.
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        wrapSelection("**");
        return;
      }
      if (k === "i" && !e.shiftKey) {
        e.preventDefault();
        wrapSelection("*");
        return;
      }
      if (k === "e" && !e.shiftKey) {
        e.preventDefault();
        wrapSelection("`");
        return;
      }
      if (k === "k" && e.shiftKey) {
        e.preventDefault();
        const start = caret;
        const end = Math.max(el.selectionEnd, start);
        // Fence just the selected span. The draft either side of the selection
        // is preserved: building the whole value from `inner` alone deleted
        // everything outside it.
        const next = draft.slice(0, start) + "```\n" + draft.slice(start, end) + "\n```" + draft.slice(end);
        setDraft(next);
        setCaretTo(start + 3);
        return;
      }
      // Spec E: Ctrl+Shift+P toggles the live preview.
      if (k === "p" && e.shiftKey) {
        e.preventDefault();
        setPreviewOn((v) => !v);
        return;
      }
    }
    // Spec A: a single backtick typed over a selection wraps it. Nothing
    // else auto-pairs.
    if (e.key === "`" && caret !== el.selectionEnd) {
      e.preventDefault();
      wrapSelection("`");
      return;
    }
    // Spec A: Backspace on an empty fenced block removes the whole block.
    if (e.key === "Backspace" && caret === el.selectionEnd) {
      const m = draft.match(/^(```[A-Za-z0-9+#_-]*)\n[ \t]*\n```$/);
      const midStart = m === null ? -1 : m[1].length + 1;
      if (m !== null && caret === midStart) {
        e.preventDefault();
        setDraft("");
        setCaretTo(0);
        return;
      }
    }
    if (e.key === "Tab") {
      handleTab(e);
      return;
    }
    if (slashItems !== null) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = slashItems.length;
        if (n > 0) {
          setSlashIdx(
            (i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n,
          );
        }
        return;
      }
      if (e.key === "Enter" && slashItems.length > 0) {
        e.preventDefault();
        runSlash(slashItems[Math.min(slashIdx, slashItems.length - 1)].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOff(true);
        setSlashIdx(0);
        return;
      }
    }
    // Spec A: ```lang + Enter/Space on the opener line builds the block.
    // Alt is left out of the chord so Alt+Space stays a system binding
    // (window menu) instead of being swallowed.
    if (
      (e.key === "Enter" || e.key === " ") &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      // Pass the character this key actually inserts — Enter its newline,
      // Space its literal space (review 15: the space must never be
      // swallowed into the opening newline).
      if (openFence(el, e.key === "Enter" ? "\n" : " ")) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter") {
      // Spec C priority: Ctrl+Enter always sends (1: menus handled above)…
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        send();
        return;
      }
      // 2: inside a fence, Enter is a newline that keeps the line indent.
      if (isInsideFence(draft, caret)) {
        e.preventDefault();
        const insert = `\n${lineIndent(caret)}`;
        const next = draft.slice(0, caret) + insert + draft.slice(el.selectionEnd);
        setDraft(next);
        setCaretTo(caret + insert.length);
        return;
      }
      // 3: a list/quote line continues (or an empty marker exits the list —
      // it is stripped and nothing sends; the next Enter on the plain line
      // sends, per spec B). Only at the END of the line: continuing from a
      // collapsed mid-line caret would fabricate a bogus next item out of
      // the line's tail ("1. he\n2. llo" — review 33). Mid-line is a plain
      // newline on a list line, and never a send.
      if (caret === el.selectionEnd) {
        const lineEndRel = draft.indexOf("\n", caret);
        const lineEnd = lineEndRel === -1 ? draft.length : lineEndRel;
        if (caret === lineEnd) {
          const cont = continueList(draft, caret);
          if (cont !== null) {
            e.preventDefault();
            setDraft(cont.text);
            setCaretTo(cont.caret);
            return;
          }
        } else {
          const lineStart = draft.lastIndexOf("\n", caret - 1) + 1;
          if (draft.slice(lineStart, caret).match(LIST_RE) !== null) {
            e.preventDefault();
            setDraft(draft.slice(0, caret) + "\n" + draft.slice(caret));
            setCaretTo(caret + 1);
            return;
          }
        }
      }
      // 4: otherwise Enter sends, Shift+Enter is a newline.
      if (sendMode !== "ctrl" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    }
  }

  // Honest estimate, labelled as one: character count over words-per-token.
  const tokens = Math.ceil(draft.length / 4);
  // Spec A: a muted hint rides the right edge while the caret sits in a fence.
  const inFence = isInsideFence(draft, caret);

  return (
    <div className="relative min-w-0 rounded-2xl border border-border bg-card p-3 focus-within:border-ring">
      {slashItems !== null && (
        <div
          role="listbox"
          aria-label="Commands"
          className="absolute right-3 bottom-full left-3 z-10 mb-1 rounded-xl border border-border bg-popover p-1"
        >
          {slashItems.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No matches</p>
          ) : (
            slashItems.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === slashIdx}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  i === slashIdx ? "bg-accent" : ""
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runSlash(c.name);
                }}
                onMouseEnter={() => {
                  setSlashIdx(i);
                }}
              >
                <b>/{c.name}</b>
                <span className="text-muted-foreground">{c.hint}</span>
              </button>
            ))
          )}
        </div>
      )}
      {previewOn && draft !== "" && (
        <div
          data-testid="composer-preview"
          className="markdown-body max-h-56 overflow-y-auto rounded-md border border-border bg-black/20 px-3 py-2"
        >
          <Markdown text={draft} />
        </div>
      )}
      <Textarea
        ref={taRef}
        aria-label="Message"
        placeholder="Write a message…"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => {
          setCaret(e.currentTarget.selectionStart);
        }}
        onKeyUp={(e) => {
          setCaret(e.currentTarget.selectionStart);
        }}
        onPaste={(e) => {
          // Spec F: multi-line plain text pastes as-is; text that LOOKS like
          // code (every non-empty line indented 2+/tab, or code characters on
          // 3+ lines) wraps in a text fence. Existing fences pass through.
          const pasted = e.clipboardData.getData("text");
          if (!pasted.includes("\n") || pasted.includes("```")) return;
          const lines = pasted.split("\n");
          const nonEmpty = lines.filter((l) => l.trim() !== "");
          const indented = nonEmpty.length > 0 && nonEmpty.every((l) => /^(\s\s|\t)/.test(l));
          const codeLines = nonEmpty.filter((l) => /(\{|};|=>)/.test(l)).length;
          if (!indented && codeLines < 3) return;
          e.preventDefault();
          const body = pasted.replace(/\n$/, "");
          // Splice the fence into the existing draft at the caret/selection —
          // never rebuild the value from the pasted text alone, which destroyed
          // whatever was already typed or selected around the insertion point.
          const start = e.currentTarget.selectionStart;
          const end = e.currentTarget.selectionEnd;
          const fenced = `\`\`\`text\n${body}\n\`\`\``;
          const next = draft.slice(0, start) + fenced + draft.slice(end);
          setDraft(next);
          setCaretTo(start + fenced.length);
          // Offer a way back: the toast's Undo reverts exactly this wrap.
          setPasteWrap({ fenced, raw: pasted, start });
        }}
        onCompositionStart={() => {
          setComposing(true);
        }}
        onCompositionEnd={() => {
          setComposing(false);
        }}
        onKeyDown={onTextareaKeyDown}
        className="max-h-48 min-h-12 w-full min-w-0 resize-none overflow-y-auto border-0 bg-transparent shadow-none focus-visible:ring-0"
      />
      {/* Paste-wrap toast (spec F): non-blocking (the wrapper ignores the
          pointer, the Undo button does not), self-dismissing, and announced
          politely via role="status". */}
      {pasteWrap !== null && (
        <div
          data-testid="paste-toast"
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute top-2 right-2 z-20 flex items-center gap-1.5 rounded-lg border border-border bg-popover/95 px-2.5 py-1.5 text-xs text-foreground shadow-md"
        >
          <span>Wrapped in code block</span>
          <button
            type="button"
            className="pointer-events-auto rounded px-1 font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => {
              undoPasteWrap(pasteWrap);
            }}
          >
            Undo
          </button>
        </div>
      )}
      <div className="mt-2 flex min-w-0 items-center gap-1.5">
        {/* The real file picker: the icon button opens it, the change event
            carries the files to onAttach. No onAttach = disabled + reason. */}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          data-testid="attach-input"
          tabIndex={-1}
          onChange={onFilesChosen}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            {onAttach === undefined ? (
              <span className="inline-flex">
                <Button type="button" variant="ghost" size="icon" aria-label="Attach a file" disabled>
                  <PlusIcon />
                </Button>
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Attach a file"
                onClick={pickFiles}
              >
                <PlusIcon />
              </Button>
            )}
          </TooltipTrigger>
          <TooltipContent>
            {onAttach === undefined
              ? "Attachments are not available here yet"
              : "Attach a file (copied into the workspace, D47)"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={memoryOff === true ? "secondary" : "ghost"}
              size="icon"
              aria-label="Memory"
              aria-pressed={memoryOff === true}
              onClick={() => {
                onMemoryToggle?.();
              }}
            >
              <BrainIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{memoryOff === true ? "Memory off" : "Memory on"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={webOn ? "secondary" : "ghost"}
              size="icon"
              aria-label="Web search"
              aria-pressed={webOn}
              onClick={() => {
                setWebOn((v) => !v);
              }}
            >
              <GlobeIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{webOn ? "Web search on" : "Web search off"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={previewOn ? "secondary" : "ghost"}
              size="icon"
              aria-label="Toggle live preview"
              aria-pressed={previewOn}
              onClick={() => {
                setPreviewOn((v) => !v);
              }}
            >
              <EyeIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {previewOn ? "Live preview on" : "Live preview (Ctrl+Shift+P)"}
          </TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        {inFence && (
          <span data-testid="fence-hint" className="text-xs text-muted-foreground">
            Code block · Ctrl+Enter to send
          </span>
        )}
        <span
          data-testid="token-hint"
          className="text-xs text-muted-foreground"
          title="Approximate input size: characters ÷ 4"
        >
          {tokens} token{tokens === 1 ? "" : "s"} · estimate
        </span>
        <Select
          value={effort}
          onValueChange={(v) => {
            // Narrow at the boundary: only the known levels reach the store —
            // no cast over an external string (review 30).
            const match = EFFORTS.find((e) => e.value === v);
            if (match === undefined) return;
            setEffort(threadId, match.value);
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectTrigger aria-label="Thinking level" size="sm" className="w-auto">
                <SelectValue />
              </SelectTrigger>
            </TooltipTrigger>
            <TooltipContent>Thinking level — request params only</TooltipContent>
          </Tooltip>
          <SelectContent>
            {EFFORTS.map((e) => (
              <SelectItem key={e.value} value={e.value}>
                {e.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ModelPicker threadId={threadId} compact />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button type="button" variant="ghost" size="icon" aria-label="Voice" disabled>
                <MicIcon />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>No voice — not ours (DESIGN.md §6)</TooltipContent>
        </Tooltip>
        {running ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                aria-label="Stop"
                onClick={onStop}
                className="rounded-full"
              >
                <SquareIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Disabled buttons take no pointer events, so the tooltip
                  rides the wrapper (same pattern as Voice below). */}
              <span className="inline-flex">
                <Button
                  type="button"
                  size="icon"
                  aria-label="Send"
                  disabled={empty}
                  onClick={() => {
                    send();
                  }}
                  className="rounded-full"
                >
                  <ArrowUpIcon />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Send</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
