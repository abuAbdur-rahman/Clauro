/**
 * Composer shell (Task 027). Textarea plus the footer action row: attach,
 * memory toggle, thinking-effort select, provider-grouped model picker,
 * disabled voice, send/stop, live token estimate, slash-command menu,
 * and markdown wrap keys.
 *
 * Send is a callback prop — no turn loop exists yet (023 owns dispatch), so
 * the shell collects intent and hands it off. Voice renders disabled with
 * its reason: no voice, DESIGN.md §6.
 *
 * Suggestion chips live with the home surface (HomeGreeting), not here:
 * App/HomeGreeting are under another hand, so this file stays chip-free.
 */
import { ArrowUpIcon, MicIcon, PlusIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useThreadStore, type Effort } from "../features/catalogue/thread";
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

export default function Composer({
  threadId,
  memoryOff,
  sendWith = "enter",
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
   *  the store has no sendWith key and turn files are out of scope. */
  sendWith?: "enter" | "ctrl";
  /** A turn is streaming: send swaps for stop in place, typing stays on. */
  running?: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  onAttach?: () => void;
  onMemoryToggle?: () => void;
  /** /compact lands here as a noop default — the real binding is 023's. */
  onCompact?: () => void;
  onSlashCommand?: (command: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashOff, setSlashOff] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pendingSel = useRef<{ start: number; end: number } | null>(null);
  const effort = useThreadStore((s) => s.threads[threadId]?.effort ?? "medium");
  const setEffort = useThreadStore((s) => s.setEffort);
  const empty = draft.trim() === "";

  // Re-apply the caret after a markdown wrap re-renders with a new value.
  useEffect(() => {
    if (pendingSel.current && taRef.current) {
      taRef.current.selectionStart = pendingSel.current.start;
      taRef.current.selectionEnd = pendingSel.current.end;
      pendingSel.current = null;
    }
  });

  function send() {
    if (running) return;
    const text = draft.trim();
    if (text === "") return;
    onSend(text);
    setDraft("");
    setSlashIdx(0);
  }

  function runSlash(command: string) {
    setDraft("");
    setSlashIdx(0);
    setSlashOff(false);
    if (command === "compact") onCompact();
    onSlashCommand?.(command);
  }

  function wrapSelection(prefix: string, suffix?: string) {
    const el = taRef.current;
    if (el === null) return;
    const suf = suffix ?? prefix;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    setDraft(draft.slice(0, s) + prefix + draft.slice(s, e) + suf + draft.slice(e));
    pendingSel.current = { start: s + prefix.length, end: e + prefix.length };
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

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
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
      if (e.key === "Enter" && !composing && slashItems.length > 0) {
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
        wrapSelection("```\n", "\n```");
        return;
      }
    }
    if (e.key === "Enter" && !composing) {
      const go = sendWith === "ctrl" ? e.ctrlKey : !e.shiftKey;
      if (go) {
        e.preventDefault();
        send();
      }
    }
  }

  // Honest estimate, labelled as one: character count over words-per-token.
  const tokens = Math.ceil(draft.length / 4);

  return (
    <div className="relative min-w-0 rounded-2xl border border-neutral-800 bg-neutral-950 p-3">
      {slashItems !== null && (
        <div
          role="listbox"
          aria-label="Commands"
          className="absolute right-3 bottom-full left-3 z-10 mb-1 rounded-xl border border-neutral-800 bg-neutral-900 p-1"
        >
          {slashItems.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-neutral-500">No matches</p>
          ) : (
            slashItems.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === slashIdx}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  i === slashIdx ? "bg-neutral-800" : ""
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
                <span className="text-neutral-400">{c.hint}</span>
              </button>
            ))
          )}
        </div>
      )}
      <Textarea
        ref={taRef}
        aria-label="Message"
        placeholder="Write a message…"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
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
      <div className="mt-2 flex min-w-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Attach a file"
              onClick={() => {
                onAttach?.();
              }}
            >
              <PlusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Attach a file (copied into the workspace, D47)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={memoryOff === true ? "secondary" : "ghost"}
              size="sm"
              aria-label="Memory"
              aria-pressed={memoryOff === true}
              onClick={() => {
                onMemoryToggle?.();
              }}
            >
              {memoryOff === true ? "Memory off" : "Memory on"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Per-chat memory toggle (locks after first send, D9)</TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <span
          data-testid="token-hint"
          className="text-xs text-neutral-500"
          title="Approximate input size: characters ÷ 4"
        >
          ≈{tokens} token{tokens === 1 ? "" : "s"} · estimate
        </span>
        <Select
          value={effort}
          onValueChange={(v) => {
            setEffort(threadId, v as Effort);
          }}
        >
          <SelectTrigger aria-label="Effort" size="sm" className="w-auto">
            <SelectValue />
          </SelectTrigger>
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
          <Button type="button" size="icon" aria-label="Stop" onClick={onStop}>
            <SquareIcon />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            aria-label="Send"
            disabled={empty}
            onClick={send}
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
    </div>
  );
}
