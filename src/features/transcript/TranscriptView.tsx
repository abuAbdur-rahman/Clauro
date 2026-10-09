/**
 * The transcript renderer (`DESIGN.md` §2.2, task 006).
 *
 * Append-only, and the UI reflects that honestly: nothing here offers to
 * delete or rewrite a row. A compaction writes a summary and supersedes rows;
 * the summary renders in place with a "replayed" affordance rather than the
 * earlier blocks pretending never to have existed.
 *
 * Row shapes follow the design exactly:
 * - **text** — a ghost row, full width, unframed. The assistant answers in a
 *   document, not in bubbles.
 * - **user turn** — the only framed row, aligned to the end.
 * - **thinking** — collapsible inline, collapsed by default (D54). Never a
 *   side pane: it would compete with the artifact drawer on exactly the turns
 *   where both matter.
 * - **tool_use / tool_result** — one row, one line until expanded (D27's
 *   bounded preview plus the path it was written to).
 * - **notice** — dropped thinking, unmappable provider events, ignored stream
 *   events. Never the compaction itself.
 */
import { useEffect, useState } from "react";
import type { ContentBlock, RenderRow } from "./types";
import { renderMarkdown } from "./markdown";

export interface TranscriptViewProps {
  rows: RenderRow[];
  /** Streamed text for the turn in flight, rendered as a trailing ghost row. */
  streaming?: string;
  /**
   * Answer one question card. Resolves when the answer is accepted; rejects
   * with the user-visible reason otherwise. Absent in read-only contexts —
   * the card then renders its options disabled with the reason inline.
   */
  onQuestionAnswer?: (toolCallId: string, answer: string) => Promise<unknown>;
}

/**
 * Markdown → purified HTML.
 *
 * `renderMarkdown` is async because the purifier loads dynamically, so the
 * component shows plain text until the first parse lands. A guard drops a
 * parse that resolves after the text moved on — otherwise a fast stream
 * renders stale HTML, which is worse than rendering late.
 */
function Markdown({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void renderMarkdown(text).then((h) => {
      if (current) setHtml(h);
    });
    return () => {
      current = false;
    };
  }, [text]);

  if (html === null) {
    return <p className="whitespace-pre-wrap text-neutral-300">{text}</p>;
  }
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function TranscriptView({ rows, streaming, onQuestionAnswer }: TranscriptViewProps) {
  if (rows.length === 0 && !streaming) {
    return (
      <p data-testid="transcript-empty" className="text-neutral-500">
        No messages yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => (
        <Row key={row.id} row={row} onQuestionAnswer={onQuestionAnswer} />
      ))}
      {streaming !== undefined && streaming.length > 0 && (
        <div data-testid="row-streaming" data-framed="false" className="max-w-none">
          <Markdown text={streaming} />
        </div>
      )}
    </div>
  );
}

function Row({
  row,
  onQuestionAnswer,
}: {
  row: RenderRow;
  onQuestionAnswer?: (toolCallId: string, answer: string) => Promise<unknown>;
}) {
  const { block } = row;
  switch (block.kind) {
    case "text":
      return row.role === "user" ? (
        <UserRow row={row} text={block.text} />
      ) : (
        <div data-testid={`row-${row.id}`} data-framed="false" className="max-w-none">
          <Markdown text={block.text} />
        </div>
      );
    case "thinking":
      return (
        <div data-testid={`row-${row.id}`} data-framed="false">
          <ThinkingRegion block={block} />
        </div>
      );
    case "tool_use":
    case "tool_result":
      return (
        <div data-testid={`row-${row.id}`} data-framed="false">
          <ToolRow
            toolUse={block.kind === "tool_use" ? block : undefined}
            result={block.kind === "tool_result" ? block : undefined}
          />
        </div>
      );
    case "notice":
      return (
        <p
          data-testid={`row-${row.id}`}
          data-framed="false"
          className={
            block.level === "error"
              ? "text-red-400"
              : block.level === "warn"
                ? "text-amber-400"
                : "text-neutral-500"
          }
        >
          {block.text}
        </p>
      );
    case "summary":
      return (
        <details data-testid={`row-${row.id}`} data-framed="false" className="text-neutral-400">
          <summary className="cursor-pointer text-neutral-500">Earlier context — replayed</summary>
          <p className="mt-2 whitespace-pre-wrap">{block.text}</p>
        </details>
      );
    case "compaction":
      return (
        <p data-testid={`row-${row.id}`} data-framed="false" className="text-neutral-500">
          This part of the conversation was compacted by the provider.
        </p>
      );
    case "question_card":
      return (
        <div data-testid={`row-${row.id}`} data-framed="false">
          <QuestionCard block={block} onQuestionAnswer={onQuestionAnswer} />
        </div>
      );
    case "artifact_ref":
      return (
        <p data-testid={`row-${row.id}`} data-framed="false" className="text-neutral-400">
          {block.title}
        </p>
      );
    default:
      // Exhaustiveness is the contract: a new variant must be rendered, not
      // silently dropped.
      return assertNever(block);
  }
}

function assertNever(x: never): React.ReactElement {
  return <p className="text-red-400">Unrenderable block: {JSON.stringify(x)}</p>;
}

/**
 * Inline answerable question card (DESIGN §2.3, D42). Options are buttons,
 * free text appears only when the card allows it, and skip is always offered
 * — the stored options may omit it (the loop appends it to the presented
 * text, not the row). A resolved card shows the choice, never the buttons:
 * answering appends, it never edits.
 */
export function QuestionCard({
  block,
  onQuestionAnswer,
}: {
  block: Extract<ContentBlock, { kind: "question_card" }>;
  onQuestionAnswer?: (toolCallId: string, answer: string) => Promise<unknown>;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (block.resolved !== null && block.resolved !== undefined) {
    return (
      <div className="rounded border border-neutral-800 p-3">
        <p className="text-neutral-200">{block.prompt}</p>
        <p className="mt-2 text-sm text-neutral-400">Answered: {block.resolved}</p>
      </div>
    );
  }

  const options = [...(block.options ?? [])];
  if (!options.some((o) => o.id === "skip")) {
    options.push({ id: "skip", label: "Skip / decide for me" });
  }

  async function answer(value: string): Promise<void> {
    if (!onQuestionAnswer) {
      setError("answering is unavailable in this view");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onQuestionAnswer(block.id, value);
    } catch (e) {
      // The card stays usable: a refused answer (already answered, unknown
      // option) is a field-level notice, never a dead card.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded border border-neutral-800 p-3">
      <p className="text-neutral-200">{block.prompt}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={pending}
            onClick={() => {
              void answer(o.id);
            }}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
          >
            {o.label}
          </button>
        ))}
      </div>
      {block.allow_free_text && (
        <div className="mt-2 flex gap-2">
          <label htmlFor={`answer-${block.id}`} className="sr-only">
            Your answer
          </label>
          <input
            id={`answer-${block.id}`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim() !== "") {
                void answer(draft.trim());
              }
            }}
            placeholder="Or write your own answer…"
            className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200"
          />
          <button
            type="button"
            disabled={pending || draft.trim() === ""}
            onClick={() => {
              void answer(draft.trim());
            }}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
          >
            Send answer
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-amber-400">
          {error}
        </p>
      )}
    </div>
  );
}

function UserRow({ row, text }: { row: RenderRow; text: string }) {
  return (
    <div className="flex justify-end">
      <div
        data-testid={`row-${row.id}`}
        data-framed="true"
        className="max-w-[80%] rounded-lg bg-neutral-800 px-3 py-2 text-neutral-100"
      >
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}

/**
 * Collapsible inline reasoning (D54). Collapsed by default, showing only a
 * one-line preview of what the region holds.
 */
export function ThinkingRegion({ block }: { block: Extract<ContentBlock, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const firstLine = block.text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 text-left text-neutral-500 hover:text-neutral-400"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="truncate">{firstLine || "Thinking"}</span>
      </button>
      {open && (
        <div className="mt-1 border-l border-neutral-800 pl-3 whitespace-pre-wrap text-neutral-500">
          {block.text}
        </div>
      )}
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  ok: "text-neutral-500",
  error: "text-amber-400",
  aborted: "text-neutral-500 italic",
  rejected: "text-neutral-400 italic",
};

/**
 * One tool call, one row. Single line until expanded, because a transcript
 * where every call is three lines tall is unreadable past ten turns
 * (`DESIGN.md:206`).
 */
export function ToolRow({
  toolUse,
  result,
}: {
  toolUse?: Extract<ContentBlock, { kind: "tool_use" }>;
  result?: Extract<ContentBlock, { kind: "tool_result" }>;
}) {
  const [open, setOpen] = useState(false);
  const callId = toolUse?.id ?? result?.tool_use_id ?? "unknown";
  const name = toolUse?.name ?? "tool";
  const status = result?.status;
  return (
    <div data-testid={`tool-${callId}`} data-status={status ?? "pending"} className="text-sm">
      <button
        type="button"
        aria-label={`${name} preview`}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 text-left"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="text-neutral-300">{name}</span>
        {status && <span className={STATUS_CLASS[status] ?? "text-neutral-500"}>{status}</span>}
      </button>
      {open && (
        <div className="mt-1 pl-4">
          {result?.preview && (
            <>
              <pre className="whitespace-pre-wrap text-neutral-500">{result.preview}</pre>
              {result.preview_path && (
                // D27: the bounded preview is not the whole output. The path is
                // how the model re-reads it, so it is shown, not hidden.
                <p className="mt-1 text-xs text-neutral-600">full output: {result.preview_path}</p>
              )}
            </>
          )}
          {toolUse && (
            <pre className="whitespace-pre-wrap text-xs text-neutral-600">{toolUse.input_json}</pre>
          )}
        </div>
      )}
    </div>
  );
}