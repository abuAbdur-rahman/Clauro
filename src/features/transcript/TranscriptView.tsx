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
import { memo, useEffect, useRef, useState } from "react";
import type { ContentBlock, RenderRow } from "./types";
import { renderMarkdown } from "./markdown";
import { enhanceCodeBlocks } from "./codeblocks";

export interface TranscriptViewProps {
  rows: RenderRow[];
  /** Streamed text for the turn in flight, rendered as a trailing ghost row. */
  streaming?: string | undefined;
  /**
   * Answer one question card. Resolves when the answer is accepted; rejects
   * with the user-visible reason otherwise. Absent in read-only contexts —
   * the card then renders its options disabled with the reason inline.
   */
  onQuestionAnswer?: ((toolCallId: string, answer: string) => Promise<unknown>) | undefined;
}

/**
 * Markdown → purified HTML.
 *
 * `renderMarkdown` is async because the purifier loads dynamically, so the
 * component shows plain text until the first parse lands. A guard drops a
 * parse that resolves after the text moved on — otherwise a fast stream
 * renders stale HTML, which is worse than rendering late.
 */
export function Markdown({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    void renderMarkdown(text).then((h) => {
      if (current) setHtml(h);
    });
    return () => {
      current = false;
    };
  }, [text]);

  // Code headers + syntax highlighting land after every parse (idempotent —
  // streaming re-renders never stack them). Highlighting is async (shiki loads
  // lazily), so this awaits; a re-render moving the DOM on is handled inside
  // via the `isConnected` guard.
  useEffect(() => {
    if (hostRef.current !== null) {
      void enhanceCodeBlocks(hostRef.current);
    }
  }, [html]);

  if (html === null) {
    return <p className="whitespace-pre-wrap text-foreground">{text}</p>;
  }
  return <div ref={hostRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function TranscriptViewImpl({ rows, streaming, onQuestionAnswer }: TranscriptViewProps) {
  if (rows.length === 0 && !streaming) {
    return (
      <p data-testid="transcript-empty" className="text-muted-foreground">
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

/**
 * Memoised (review 32): ChatView re-renders per coalesced frame while
 * streaming, and a stable transcript must not re-reconcile every row — each
 * row carries a Markdown parse. Shallow prop compare is enough: `rows` are
 * state identities, and ChatView passes a stable `onQuestionAnswer`.
 */
export const TranscriptView = memo(TranscriptViewImpl);

const Row = memo(function Row({
  row,
  onQuestionAnswer,
}: {
  row: RenderRow;
  onQuestionAnswer?: ((toolCallId: string, answer: string) => Promise<unknown>) | undefined;
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
              ? "text-destructive"
              : block.level === "warn"
                ? "text-warning"
                : "text-muted-foreground"
          }
        >
          {block.text}
        </p>
      );
    case "summary":
      return (
        <details data-testid={`row-${row.id}`} data-framed="false" className="text-muted-foreground">
          <summary className="cursor-pointer text-foreground">Earlier context — replayed</summary>
          <p className="mt-2 whitespace-pre-wrap">{block.text}</p>
        </details>
      );
    case "compaction":
      return (
        <p data-testid={`row-${row.id}`} data-framed="false" className="text-muted-foreground">
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
        <p data-testid={`row-${row.id}`} data-framed="false" className="text-muted-foreground">
          {block.title}
        </p>
      );
    default:
      // Exhaustiveness is the contract: a new variant must be rendered, not
      // silently dropped.
      return assertNever(block);
  }
});

function assertNever(x: never): React.ReactElement {
  // D27 — bounded on the way out. The dump exists to identify the schema
  // drift, not to replay the row: a drifted block can be arbitrarily large,
  // and the transcript is not where the whole payload belongs (review 15).
  const dump = JSON.stringify(x);
  const bounded = dump.length > 240 ? `${dump.slice(0, 240)}…` : dump;
  return <p className="text-destructive">Unrenderable block: {bounded}</p>;
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
  onQuestionAnswer?: ((toolCallId: string, answer: string) => Promise<unknown>) | undefined;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Review 15 NIT: an Enter that commits a CJK composition must not send a
  // half-typed answer. Same guard as Composer.tsx — composition state is
  // tracked explicitly rather than read off the event.
  const [composing, setComposing] = useState(false);

  if (block.resolved !== null && block.resolved !== undefined) {
    return (
      <div className="rounded border border-border p-3">
        <p className="text-foreground">{block.prompt}</p>
        <p className="mt-2 text-sm text-muted-foreground">Answered: {block.resolved}</p>
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
    <div className="rounded border border-border p-3">
      <p className="text-foreground">{block.prompt}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={pending}
            onClick={() => {
              void answer(o.id);
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
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
            onCompositionStart={() => {
              setComposing(true);
            }}
            onCompositionEnd={() => {
              setComposing(false);
            }}
            onKeyDown={(e) => {
              // `composing`: the Enter that commits an IME composition lands
              // here mid-composition — it must not answer (review 15).
              if (e.key === "Enter" && !composing && draft.trim() !== "") {
                void answer(draft.trim());
              }
            }}
            placeholder="Or write your own answer…"
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground"
          />
          <button
            type="button"
            disabled={pending || draft.trim() === ""}
            onClick={() => {
              void answer(draft.trim());
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            Send answer
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-warning">
          {error}
        </p>
      )}
    </div>
  );
}

function UserRow({ row, text }: { row: RenderRow; text: string }) {
  // Fenced messages render through the shared markdown pipeline so the
  // sender's own code block looks like every other block (language label,
  // Copy). Plain text stays a literal pre-wrap bubble — single newlines and
  // all — because marked without `breaks` would collapse them to spaces.
  // A fence is a line that STARTS with one (review 33 NIT): a stray inline
  // triple-backtick must not drag the whole message through markdown.
  const fenced = /^```/m.test(text);
  return (
    <div className="flex justify-end">
      <div
        data-testid={`row-${row.id}`}
        data-framed="true"
        className="max-w-[80%] overflow-hidden rounded-lg border border-border bg-secondary px-3 py-2 text-foreground"
      >
        {fenced ? <Markdown text={text} /> : <p className="whitespace-pre-wrap">{text}</p>}
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
        className="flex w-full items-center gap-2 text-left text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="truncate">{firstLine || "Thinking"}</span>
      </button>
      {open && (
        <div className="mt-1 border-l border-border pl-3 whitespace-pre-wrap text-muted-foreground">
          {block.text}
        </div>
      )}
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  ok: "text-muted-foreground",
  error: "text-warning",
  aborted: "text-muted-foreground italic",
  rejected: "text-muted-foreground italic",
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
  toolUse?: Extract<ContentBlock, { kind: "tool_use" }> | undefined;
  result?: Extract<ContentBlock, { kind: "tool_result" }> | undefined;
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
        <span className="text-foreground">{name}</span>
        {status && <span className={STATUS_CLASS[status] ?? "text-muted-foreground"}>{status}</span>}
      </button>
      {open && (
        <div className="mt-1 pl-4">
          {result?.preview && (
            <>
              <pre className="whitespace-pre-wrap text-muted-foreground">{result.preview}</pre>
              {result.preview_path && (
                // D27: the bounded preview is not the whole output. The path is
                // how the model re-reads it, so it is shown, not hidden.
                <p className="mt-1 text-xs text-muted-foreground">full output: {result.preview_path}</p>
              )}
            </>
          )}
          {toolUse && (
            <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{toolUse.input_json}</pre>
          )}
        </div>
      )}
    </div>
  );
}