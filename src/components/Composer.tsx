/**
 * Composer shell (Task 027). Textarea plus the footer action row: attach,
 * memory toggle, thinking-effort select, provider-grouped model picker,
 * disabled voice, send.
 *
 * Send is a callback prop — no turn loop exists yet (023 owns dispatch), so
 * the shell collects intent and hands it off. Voice renders disabled with
 * its reason: no voice, DESIGN.md §6.
 */
import { ArrowUpIcon, MicIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
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

export default function Composer({
  threadId,
  memoryOff,
  onSend,
  onAttach,
  onMemoryToggle,
}: {
  threadId: string;
  /** Controlled memory state; 008/018 own the source of truth. */
  memoryOff?: boolean;
  onSend: (text: string) => void;
  onAttach?: () => void;
  onMemoryToggle?: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const effort = useThreadStore((s) => s.threads[threadId]?.effort ?? "medium");
  const setEffort = useThreadStore((s) => s.setEffort);
  const empty = draft.trim() === "";

  function send() {
    const text = draft.trim();
    if (text === "") return;
    onSend(text);
    setDraft("");
  }

  return (
    <div className="min-w-0 rounded-2xl border border-neutral-800 bg-neutral-950 p-3">
      <Textarea
        aria-label="Message"
        placeholder="Write a message…"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        className="min-h-12 w-full min-w-0 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
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
        <Button
          type="button"
          size="icon"
          aria-label="Send"
          disabled={empty}
          onClick={send}
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  );
}
