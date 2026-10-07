// @vitest-environment jsdom
/**
 * D100 — transcript markdown is purified before render, and a streaming
 * generation reparses at most once per frame.
 *
 * Model output is untrusted text. Anything reaching the transcript DOM passes
 * the purifier first, and a long generation does not reparse per token.
 *
 * The tests are deliberately hostile: `<script>`, an event-handler attribute,
 * a `javascript:` URL, and a raw HTML block. Each must come out inert.
 */
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";
import { FrameCoalescer } from "./frame";

describe("renderMarkdown", () => {
  it("renders ordinary markdown", async () => {
    const html = await renderMarkdown("**bold** and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders lists and headings", async () => {
    const html = await renderMarkdown("# Title\n\n- one\n- two");
    expect(html).toContain("<h1");
    expect(html).toContain("<li>one</li>");
  });

  // ── D100: the purifier is not optional ────────────────────────────────────

  it("strips a script tag", async () => {
    const html = await renderMarkdown("before\n\n<script>alert(1)</script>\n\nafter");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    // The surrounding text survives: purification removes the danger, not the
    // message.
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("strips an inline event-handler attribute", async () => {
    const html = await renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });

  // Proves the default URI regexp is relied on deliberately, not by accident —
  // `features/artifact/sanitize.ts` documents why setting one is a trap.
  it("strips a javascript: url with the default configuration", async () => {
    const html = await renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("strips raw html that tries to open a frame", async () => {
    const html = await renderMarkdown('<iframe src="https://evil.example"></iframe>');
    expect(html).not.toContain("<iframe");
  });

  it("keeps inline code intact even when it looks like a tag", async () => {
    const html = await renderMarkdown("use `<script>` carefully");
    // The code span shows the literal text; it must not become a live tag.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never returns a live dangerous node for adversarial input", async () => {
    const nasty = [
      "<script>x</script>",
      "<img src=x onerror=alert(1)>",
      "<svg/onload=alert(1)>",
      "<a href='javascript:alert(1)'>x</a>",
      "<style>body{display:none}</style>",
      "<iframe src='https://evil.example'></iframe>",
    ].join("\n\n");
    const html = await renderMarkdown(nasty);

    // Assert on the parsed DOM, not on substrings. `onload` legitimately
    // survives inside *escaped* text — that is inert, and a substring match
    // cannot tell the two apart. What must not exist is a live node.
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const tag of ["script", "iframe", "style", "object", "embed", "form"]) {
      expect(doc.querySelectorAll(tag).length, `${tag} must not survive`).toBe(0);
    }
    const all = Array.from(doc.querySelectorAll("*"));
    for (const el of all) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith("on"), `${attr.name} must not survive`).toBe(
          false,
        );
      }
      const href = el.getAttribute("href");
      if (href) expect(href.toLowerCase()).not.toContain("javascript:");
    }
  });

  it("handles empty input without throwing", async () => {
    await expect(renderMarkdown("")).resolves.toBeTypeOf("string");
  });
});

describe("FrameCoalescer", () => {
  it("coalesces many updates into one flush per frame", async () => {
    const flushed: string[] = [];
    const c = new FrameCoalescer((text) => flushed.push(text));
    c.push("a");
    c.push("b");
    c.push("c");
    expect(flushed).toEqual([]);
    await c.flushSoon();
    expect(flushed).toEqual(["abc"]);
  });

  it("does not schedule a second frame when one is already pending", async () => {
    const flushed: string[] = [];
    const c = new FrameCoalescer((text) => flushed.push(text));
    c.push("a");
    c.push("b");
    await c.flushSoon();
    await c.flushSoon();
    expect(flushed).toEqual(["ab"]);
  });

  it("flushes synchronously when asked, for a completed turn", () => {
    const flushed: string[] = [];
    const c = new FrameCoalescer((text) => flushed.push(text));
    c.push("done");
    c.flushNow();
    expect(flushed).toEqual(["done"]);
  });
});