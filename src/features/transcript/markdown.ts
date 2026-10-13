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
 *    The config is a strict **allowlist** (review 15). The earlier blocklist
 *    (`FORBID_TAGS`) could only be as strong as its last omission: svg, math,
 *    video, base, meta, details and every `<img src="https://…">` stayed live,
 *    and a dependency that grows a feature grows a new hole in a blacklist.
 *    An allowlist cannot regress that way — a tag nobody listed simply does
 *    not render.
 *
 *    The purifier is loaded **dynamically**, for the same reason the artifact
 *    frame does it (`D4`): a static import puts ~100 KB of sanitiser in the
 *    main chunk, paid on every launch to clean a transcript that usually has
 *    nothing dangerous in it. That is why `renderMarkdown` is async — the
 *    caller awaits the first render, then the instance is cached.
 *
 *    Note what is deliberately absent alongside the blocklist:
 *    `ALLOWED_URI_REGEXP`. Setting it puts DOMPurify on a different
 *    configuration path which, on 3.x, drops camelCase attributes — the same
 *    trap `features/artifact/sanitize.ts` documents. The allowlist needs only
 *    lowercase ASCII attributes, and DOMPurify's default URI regexp already
 *    refuses `javascript:` (entity/tab/newline tricks included, because it
 *    tests the value with control characters stripped) and `data:` on `href`
 *    — `markdown.test.ts` asserts both directly rather than trusting this
 *    comment.
 *
 * 2. **Coalesce.** A streaming turn delivers deltas far faster than a frame.
 *    Reparsing per delta is a parse per token; the transcript renders at most
 *    once per animation frame, over the accumulated text.
 */
interface Purifier {
  sanitize: (dirty: string, config?: unknown) => string;
}

/**
 * `marked` is imported dynamically for the same reason the purifier is: a
 * static import pins ~46 KB of parser into the entry chunk, paid on every
 * launch for a transcript that is mostly prose. `renderMarkdown` is already
 * async, so the caller's shape does not change and the module is fetched once
 * and cached by the bundler. This is a **loading** change only — the parse
 * options and the sanitiser config are untouched, so the HTML for a given
 * input is byte-identical.
 */
async function parseMarkdown(source: string): Promise<string> {
  const { Marked } = await import("marked");
  const marked = new Marked({ gfm: true, breaks: false });
  return marked.parse(source, { async: false });
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
  const raw = await parseMarkdown(source);
  try {
    const p = await loadPurifier();
    return p.sanitize(raw, {
      // The transcript's whole surface, listed. Marked's GFM output needs
      // these and nothing else; raw model HTML beyond them keeps its text
      // (DOMPurify's KEEP_CONTENT) and loses its shell. Review 15: a
      // blocklist can only be as strong as its last omission.
      ALLOWED_TAGS: [
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "br",
        "hr",
        "blockquote",
        "strong",
        "em",
        "b",
        "i",
        "del",
        "s",
        "ul",
        "ol",
        "li",
        "a",
        "pre",
        "code",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
      ],
      // href/title ride along with the default URI policy (no `javascript:`,
      // no `data:` on href); align/start/colspan/rowspan carry table and list
      // structure; class carries `language-*`, which codeblocks.ts reads.
      ALLOWED_ATTR: ["href", "title", "class", "align", "start", "colspan", "rowspan"],
      // data-* is the host's namespace: codeblocks.ts treats data-codeblock
      // and data-highlighted as trusted state, so a model must not be able to
      // set them. aria-* passes on its own (inert values) and stays allowed.
      ALLOW_DATA_ATTR: false,
      // `img` is deliberately **not** listed. The transcript fetches nothing:
      // no proxy mediates a remote image (tracking pixel, IP leak — D3's
      // egress rule for the artifact frame applies here too, review 15), and
      // a `data:` image is a multi-MB render bomb. `![alt](url)` therefore
      // renders as nothing; a future image feature needs a proxy, a size cap
      // and its own D-number before any `img` returns to this list.
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