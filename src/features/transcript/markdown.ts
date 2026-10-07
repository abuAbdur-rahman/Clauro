/**
 * D100 — transcript markdown is purified before render, and a streaming
 * generation reparses at most once per frame.
 *
 * Two halves, both load-bearing:
 *
 * 1. **Purify.** Model output is untrusted. It is rendered to an HTML string
 *    and then passed through DOMPurify before any consumer touches it. The
 *    order matters: trusting `marked`'s own escaping leaves a hole that a new
 *    markdown feature can reopen tomorrow.
 *
 *    The purifier is loaded **dynamically**, for the same reason the artifact
 *    frame does it (`D4`): a static import puts ~100 KB of sanitiser in the
 *    main chunk, paid on every launch to clean a transcript that usually has
 *    nothing dangerous in it. That is why `renderMarkdown` is async — the
 *    caller awaits the first render, then the instance is cached.
 *
 *    Note what is deliberately absent: `ALLOWED_URI_REGEXP`. Setting it puts
 *    DOMPurify on a different configuration path which, on 3.x, drops
 *    camelCase attributes — the same trap `features/artifact/sanitize.ts`
 *    documents. DOMPurify's default URI regexp already refuses `javascript:`,
 *    and `tests/markdown.test.ts` asserts that directly rather than trusting
 *    the comment.
 *
 * 2. **Coalesce.** A streaming turn delivers deltas far faster than a frame.
 *    Reparsing per delta is a parse per token; the transcript renders at most
 *    once per animation frame, over the accumulated text.
 */
import { Marked } from "marked";

interface Purifier {
  sanitize: (dirty: string, config?: unknown) => string;
}

/** Cached after the first load, so a re-render does not re-import. */
let purifier: Promise<Purifier> | null = null;

function loadPurifier(): Promise<Purifier> {
  if (purifier) return purifier;
  purifier = (async () => {
    const imported: unknown = (await import("dompurify")).default;
    // The default export is an instance where a window exists and a factory
    // where one does not. Both are handled; neither is assumed. Same reasoning
    // as `features/artifact/sanitize.ts`.
    return typeof imported === "function"
      ? (imported as (win: Window) => Purifier)(window)
      : (imported as Purifier);
  })();
  return purifier;
}

/**
 * Markdown → sanitised HTML. The only path from model text to transcript HTML.
 *
 * `renderMarkdown` returns the purified string, so a caller cannot obtain
 * unsanitised output from here. If the purifier itself fails to load, the
 * message renders as escaped text rather than raw HTML — degrading to a
 * readable transcript beats degrading to an XSS.
 */
export async function renderMarkdown(source: string): Promise<string> {
  const marked = new Marked({ gfm: true, breaks: false });
  const raw = marked.parse(source, { async: false });
  try {
    const p = await loadPurifier();
    return p.sanitize(raw, {
      // The transcript fetches nothing: no iframes, no forms, no stylesheets.
      // A model that emits one has it stripped and the rest still renders.
      FORBID_TAGS: ["script", "iframe", "object", "embed", "style", "link", "form", "input"],
      FORBID_ATTR: ["style", "srcset", "formaction", "target"],
    });
  } catch {
    return escapeHtml(raw);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Accumulate streaming text and emit it at most once per animation frame.
 *
 * Pushes before the scheduled frame are concatenated; the first push after a
 * flush schedules the next one. `flushNow` bypasses the frame — used when a
 * turn completes and the final text must not wait for a tick.
 */
export class FrameCoalescer {
  private buffered = "";
  private pending: Promise<void> | null = null;
  private resolvePending: (() => void) | null = null;

  constructor(private readonly emit: (text: string) => void) {}

  /** Add streamed text. No output until the frame fires. */
  push(text: string): void {
    this.buffered += text;
    if (!this.pending) this.schedule();
  }

  private schedule(): void {
    this.pending = new Promise<void>((resolve) => {
      this.resolvePending = resolve;
      // `requestAnimationFrame` is absent in a non-DOM test environment; fall
      // back to a macrotask so the coalescing contract holds either way.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          this.fire();
        });
      } else {
        setTimeout(() => {
          this.fire();
        }, 0);
      }
    });
  }

  private fire(): void {
    const text = this.buffered;
    this.buffered = "";
    this.pending = null;
    const resolve = this.resolvePending;
    this.resolvePending = null;
    if (text.length > 0) this.emit(text);
    resolve?.();
  }

  /** Force a flush and resolve once it has happened. */
  async flushSoon(): Promise<void> {
    if (!this.pending) return;
    await this.pending;
  }

  /** Flush synchronously — for a completed turn, where the last delta matters. */
  flushNow(): void {
    if (!this.pending) {
      if (this.buffered.length > 0) {
        const text = this.buffered;
        this.buffered = "";
        this.emit(text);
      }
      return;
    }
    this.fire();
  }
}