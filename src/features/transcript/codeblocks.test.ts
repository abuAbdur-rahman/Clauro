// @vitest-environment jsdom
/**
 * Transcript code blocks (Task 032 follow-up): every fenced block renders a
 * header row — language label + Copy — over plain `<pre><code>`. Plaintext
 * rendering (no highlighter vendored); enhancement is idempotent so streaming
 * re-renders never stack headers.
 */
import { describe, expect, it, vi } from "vitest";
import { codeBlockLanguage, enhanceCodeBlocks, GRAMMARS } from "./codeblocks";

function host(inner: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = inner;
  document.body.appendChild(div);
  return div;
}

describe("codeBlockLanguage", () => {
  it("lowercases the marked language class", () => {
    const code = document.createElement("code");
    code.className = "language-TypeScript";
    expect(codeBlockLanguage(code)).toBe("typescript");
  });

  it("falls back to text for empty or invalid languages, never throws", () => {
    const plain = document.createElement("code");
    expect(codeBlockLanguage(plain)).toBe("text");
    const weird = document.createElement("code");
    weird.className = "language-<img>";
    expect(codeBlockLanguage(weird)).toBe("text");
  });
});

describe("enhanceCodeBlocks", () => {
  it("adds a header with language label and Copy button", async () => {
    const root = host('<pre><code class="language-ts">const a = 1;</code></pre>');
    await enhanceCodeBlocks(root);
    const head = root.querySelector(".codeblock-head");
    expect(head?.textContent).toContain("ts");
    expect(head?.querySelector("button")?.textContent).toBe("Copy");
  });

  it("is idempotent across streaming re-renders", async () => {
    const root = host('<pre><code class="language-rs">let x = 1;</code></pre>');
    await enhanceCodeBlocks(root);
    await enhanceCodeBlocks(root);
    expect(root.querySelectorAll(".codeblock-head")).toHaveLength(1);
  });

  it("leaves plain pre blocks without code alone", async () => {
    const root = host("<pre>just text</pre>");
    await enhanceCodeBlocks(root);
    expect(root.querySelector(".codeblock-head")).toBeNull();
  });

  it("copy writes the code text and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const root = host('<pre><code class="language-js">alert(1)</code></pre>');
    await enhanceCodeBlocks(root);
    const btn = root.querySelector(".codeblock-head button");
    expect(btn).not.toBeNull();
    (btn as HTMLButtonElement).click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("alert(1)");
    expect((btn as HTMLButtonElement).textContent).toBe("Copied");
    vi.unstubAllGlobals();
    root.remove();
  });

  it("copy without a clipboard API keeps the Copy label (review 33: never lie)", async () => {
    // `navigator.clipboard` is absent in insecure contexts and some
    // embeddings. `await clipboard?.writeText(...)` on an undefined
    // clipboard is a silent no-op that still falls through to "Copied" —
    // the button claims success without writing anything, exactly what
    // copyCode's own catch comment says it must not do.
    vi.stubGlobal("navigator", {});
    const root = host('<pre><code class="language-js">alert(1)</code></pre>');
    await enhanceCodeBlocks(root);
    const btn = root.querySelector(".codeblock-head button") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    await Promise.resolve();
    expect(btn.textContent).toBe("Copy");
    vi.unstubAllGlobals();
    root.remove();
  });
});

describe("syntax highlighting", () => {
  it("applies colour to tokens in a recognised language", async () => {
    const root = host('<pre><code class="language-rust">fn main() {}</code></pre>');
    await enhanceCodeBlocks(root);
    const spans = root.querySelectorAll("pre code span");
    expect(spans.length).toBeGreaterThan(0);
    // At least one token carries a colour (shiki sets an inline style).
    const coloured = [...spans].some((s) => (s as HTMLElement).style.color !== "");
    expect(coloured).toBe(true);
    root.remove();
  });

  it("leaves plain text blocks unhighlighted", async () => {
    const root = host('<pre><code class="language-text">fn main() {}</code></pre>');
    await enhanceCodeBlocks(root);
    const spans = root.querySelectorAll("pre code span");
    const coloured = [...spans].some((s) => (s as HTMLElement).style.color !== "");
    expect(coloured).toBe(false);
    root.remove();
  });
});

describe("grammar loading (bundle-split shape)", () => {
  // The startup investigation measured ~84% of the entry chunk attributed to
  // shiki: statically-evaluated grammar modules are parsed on every launch,
  // not just on first code block. Each GRAMMARS entry must therefore be a
  // lazy thunk that resolves to its grammar module on demand — a loaded
  // grammar object here means the split is broken again.
  it("keeps every grammar (including aliases) behind a lazy thunk", async () => {
    const values = Object.values(GRAMMARS);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(typeof value).toBe("function");
    }
    // The thunk must actually resolve to a grammar, not just be a function.
    const rust = GRAMMARS.rust;
    if (typeof rust !== "function") throw new Error("rust grammar is not a thunk");
    const resolved = await rust();
    expect(resolved).toBeTruthy();
  });
});
