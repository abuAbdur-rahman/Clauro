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
 * only its own generated spans. The highlighter loads lazily behind the first
 * code block (its grammars are not paid on every launch for a transcript that
 * is usually prose), and a failed load degrades to plaintext rather than
 * throwing.
 */
import type { HighlighterCore, LanguageInput } from "shiki";
// The core API, JS engine, grammars and theme are imported **statically**. A
// bare *dynamic* specifier — `await import("shiki/core")` or the template
// `import(\`shiki/langs/${l}.mjs\`)` — is not resolvable by the browser in a
// built bundle: Rollup emits it as a runtime glob the static host cannot serve,
// so the import throws and highlighting silently degrades to plaintext (jsdom
// hides this because vitest resolves specifiers itself). A static import gives
// the bundler a real dependency edge. The cost is that the grammars join the
// chunk graph, so this is a deliberate, recorded trade-off: a focused language
// set keeps the bundle honest.
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import rust from "shiki/langs/rust.mjs";
import typescript from "shiki/langs/typescript.mjs";
import javascript from "shiki/langs/javascript.mjs";
import tsx from "shiki/langs/tsx.mjs";
import jsx from "shiki/langs/jsx.mjs";
import python from "shiki/langs/python.mjs";
import go from "shiki/langs/go.mjs";
import java from "shiki/langs/java.mjs";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/csharp.mjs";
import ruby from "shiki/langs/ruby.mjs";
import php from "shiki/langs/php.mjs";
import swift from "shiki/langs/swift.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import json from "shiki/langs/json.mjs";
import yaml from "shiki/langs/yaml.mjs";
import toml from "shiki/langs/toml.mjs";
import sql from "shiki/langs/sql.mjs";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import html from "shiki/langs/html.mjs";
import xml from "shiki/langs/xml.mjs";
import markdown from "shiki/langs/markdown.mjs";
import diff from "shiki/langs/diff.mjs";
import docker from "shiki/langs/docker.mjs";
import graphql from "shiki/langs/graphql.mjs";
import githubDark from "shiki/themes/github-dark.mjs";

const ENHANCED_ATTR = "data-codeblock";
const LANG_RE = /^[a-z0-9+#_-]+$/;

/**
 * Grammar alias → the shiki module that colourises it. Anything absent renders
 * plaintext (never throws). Aliases collapse onto the grammar that already
 * covers them: `shell`→bash, `js`/`mjs`/`cjs`→javascript, etc.
 */
const GRAMMARS: Record<string, LanguageInput> = {
  rust,
  typescript,
  javascript,
  tsx,
  jsx,
  python,
  go,
  java,
  c,
  cpp,
  csharp,
  ruby,
  php,
  swift,
  kotlin,
  json,
  yaml,
  toml,
  sql,
  bash,
  shell: bash,
  sh: bash,
  zsh: bash,
  js: javascript,
  mjs: javascript,
  cjs: javascript,
  ts: typescript,
  node: javascript,
  css,
  scss: css,
  html,
  xml,
  svg: xml,
  markdown,
  md: markdown,
  diff,
  patch: diff,
  docker,
  dockerfile: docker,
  graphql,
  gql: graphql,
};

/** Highlighted-language code must not be re-processed by a later pass. */
const HIGHLIGHTED_ATTR = "data-highlighted";

/** Cached after the first load, so a re-render does not re-import. */
let highlighterPromise: Promise<HighlighterCore | null> | null = null;

function loadHighlighter(): Promise<HighlighterCore | null> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    try {
      return await createHighlighterCore({
        themes: [githubDark],
        // Every grammar the app can colourise, statically imported above.
        langs: Object.values(GRAMMARS),
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
    await clipboard?.writeText(code.textContent);
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
