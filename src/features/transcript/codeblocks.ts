/**
 * Transcript code-block headers (Task 032 follow-up) + syntax highlighting.
 * The markdown pipeline emits plain `<pre><code class="language-x">`; this
 * pass adds a header row (language label + Copy) per block and colours the
 * tokens via shiki. DOM enhancement — not string surgery — so the purifier's
 * guarantees stay intact, and idempotency (one header per block, ever) keeps
 * streaming re-renders honest.
 *
 * Highlighting runs **after** sanitisation, on the already-purified DOM:
 * shiki's token spans are built from a parsed document and copied across as
 * live nodes, never reparsed as markup from a string. That keeps the purifier's
 * `FORBID_ATTR: ["style"]` posture (inline style is an XSS vector) intact for
 * everything the model emitted, while letting the trusted highlighter colourise
 * only its own generated spans. The highlighter (core, JS engine, theme and
 * grammars) loads lazily behind the first code block — none of it sits in the
 * entry bundle, so a transcript that is usually prose pays nothing for it at
 * launch — and a failed load degrades to plaintext rather than throwing.
 */
import type { HighlighterCore, LanguageInput } from "shiki";
// Every shiki **value** import here — core, JS regex engine, theme, grammars —
// is a dynamic import with an explicit literal specifier, awaited inside
// `loadHighlighter`. Literal specifiers are statically analysable, so Rollup
// emits real async chunks and the whole highlighter graph (measured: ~84% of
// the old entry chunk) leaves the boot path — parsed only behind the first
// code block. What is *not* statically analysable is a template/glob
// specifier like `import(\`shiki/langs/${l}.mjs\`)`: Rollup emits a runtime
// glob the static host cannot serve and the import throws (jsdom hides this —
// vitest resolves specifiers itself). So each grammar gets its own literal
// thunk — shiki's own lazy-loader shape: `LanguageInput` accepts
// `() => import("shiki/langs/rust.mjs")` and unwraps the module's `default`.
// A failed load still degrades to plaintext rather than throwing.

const ENHANCED_ATTR = "data-codeblock";
const LANG_RE = /^[a-z0-9+#_-]+$/;

const loadBash = () => import("shiki/langs/bash.mjs");
const loadJavaScript = () => import("shiki/langs/javascript.mjs");
const loadTypeScript = () => import("shiki/langs/typescript.mjs");
const loadCss = () => import("shiki/langs/css.mjs");
const loadXml = () => import("shiki/langs/xml.mjs");
const loadMarkdown = () => import("shiki/langs/markdown.mjs");
const loadDiff = () => import("shiki/langs/diff.mjs");

/**
 * Grammar alias → a **lazy thunk** that imports the shiki module which
 * colourises it. Anything absent renders plaintext (never throws). Aliases
 * collapse onto the loader that already covers them: `shell`→bash,
 * `js`/`mjs`/`cjs`→javascript, etc. Values are thunks (never loaded grammar
 * objects) so no grammar module is evaluated until the first code block —
 * `codeblocks.test.ts` pins that.
 */
export const GRAMMARS: Record<string, LanguageInput> = {
  rust: () => import("shiki/langs/rust.mjs"),
  typescript: loadTypeScript,
  javascript: loadJavaScript,
  tsx: () => import("shiki/langs/tsx.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  bash: loadBash,
  shell: loadBash,
  sh: loadBash,
  zsh: loadBash,
  js: loadJavaScript,
  mjs: loadJavaScript,
  cjs: loadJavaScript,
  ts: loadTypeScript,
  node: loadJavaScript,
  css: loadCss,
  scss: loadCss,
  html: () => import("shiki/langs/html.mjs"),
  xml: loadXml,
  svg: loadXml,
  markdown: loadMarkdown,
  md: loadMarkdown,
  diff: loadDiff,
  patch: loadDiff,
  docker: () => import("shiki/langs/docker.mjs"),
  dockerfile: () => import("shiki/langs/docker.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  gql: () => import("shiki/langs/graphql.mjs"),
};

/** Highlighted-language code must not be re-processed by a later pass. */
const HIGHLIGHTED_ATTR = "data-highlighted";

/** Cached after the first load, so a re-render does not re-import. */
let highlighterPromise: Promise<HighlighterCore | null> | null = null;

function loadHighlighter(): Promise<HighlighterCore | null> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    try {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, { default: githubDark }] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("shiki/themes/github-dark.mjs"),
        ]);
      return await createHighlighterCore({
        themes: [githubDark],
        // Every grammar the app can colourise, as lazy thunks (see GRAMMARS).
        // `Set` collapses the aliases that share one loader.
        langs: [...new Set(Object.values(GRAMMARS))],
        engine: createJavaScriptRegexEngine(),
      });
    } catch {
      // Highlighting is decorative; a failed load degrades to plaintext.
      return null;
    }
  })();
  return highlighterPromise;
}

/** Lowercased marked language, or `text` for empty/invalid — never throws. */
export function codeBlockLanguage(code: Element): string {
  const raw =
    [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
  const lang = raw.toLowerCase();
  return lang !== "" && LANG_RE.test(lang) ? lang : "text";
}

async function copyCode(code: HTMLElement, button: HTMLButtonElement): Promise<void> {
  try {
    const clipboard = (navigator as unknown as { clipboard?: { writeText: (t: string) => Promise<void> } }).clipboard;
    if (clipboard === undefined) {
      // No clipboard API (insecure context, locked-down embedding): the
      // optional call would silently no-op and still flip the label —
      // the button must not claim a write that never happened (review 33).
      return;
    }
    await clipboard.writeText(code.textContent);
    button.textContent = "Copied";
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = "Copy";
    }, 1500);
  } catch {
    // Clipboard unavailable (permissions, insecure context): the button stays
    // a Copy button instead of lying about success.
  }
}

/** Add headers to every unenhanced `pre > code` block under root. */
export async function enhanceCodeBlocks(root: ParentNode): Promise<void> {
  const toHighlight: { code: HTMLElement; lang: string }[] = [];

  for (const pre of root.querySelectorAll("pre")) {
    if (!(pre instanceof HTMLElement) || pre.hasAttribute(ENHANCED_ATTR)) continue;
    const code = pre.querySelector(":scope > code");
    if (!(code instanceof HTMLElement)) continue;
    pre.setAttribute(ENHANCED_ATTR, "");
    const header = document.createElement("div");
    header.className = "codeblock-head";
    const label = document.createElement("span");
    label.textContent = codeBlockLanguage(code);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codeblock-copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", `Copy ${codeBlockLanguage(code)} code`);
    button.addEventListener("click", () => {
      void copyCode(code, button);
    });
    header.append(label, button);
    pre.prepend(header);

    const lang = codeBlockLanguage(code);
    if (lang !== "text" && !code.hasAttribute(HIGHLIGHTED_ATTR)) {
      toHighlight.push({ code, lang });
    }
  }

  if (toHighlight.length === 0) return;

  const highlighter = await loadHighlighter();
  if (!highlighter) return; // decorative; degrade to plaintext

  for (const { code, lang } of toHighlight) {
    if (!code.isConnected) continue; // streaming re-render moved on
    // `codeBlockLanguage` can return an alias (`shell`, `js`, `md`) that shiki
    // has not registered under that exact name. Resolve it back to the grammar
    // we actually loaded, and skip if we have none — `codeToHtml` throws on an
    // unknown language. `in` narrows the index lookup to `| undefined` so the
    // guard is both runtime-correct and type-visible.
    if (!(lang in GRAMMARS)) continue;
    const source = code.textContent;
    // `codeToHtml` wraps output in `<pre><code>`; we only want the inner token
    // spans. Parse it, then copy the live child nodes across — never inject the
    // string as `innerHTML`, so nothing the highlighter emitted is reparsed as
    // markup. The source text is already DOM-escaped by shiki before it reaches
    // us, and we move only element nodes, so a `<` in the code stays text.
    let html: string;
    try {
      html = highlighter.codeToHtml(source, { lang, theme: "github-dark" });
    } catch {
      continue; // unknown alias that slipped past GRAMMARS — leave plaintext
    }
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const innerCode = parsed.querySelector("pre > code");
    if (innerCode == null) continue;
    code.replaceChildren(...[...innerCode.childNodes].map((n) => document.importNode(n, true)));
    code.setAttribute(HIGHLIGHTED_ATTR, "");
  }
}
