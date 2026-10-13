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

  it("renders ordered lists with numbering intact", async () => {
    const html = await renderMarkdown("1. first\n2. second\n3. third");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>third</li>");
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

// ── Review 15: strict allowlist, and nothing in the transcript fetches ─────
//
// The blocklist posture can only be as strong as its last omission: under
// `FORBID_TAGS` every unlisted tag (svg, math, video, base, meta, details…)
// and every `<img src="https://…">` stayed live. These tests parse the DOM —
// a substring match cannot tell an escaped payload (inert) from a live one —
// and each payload is the one review 15 names or an mXSS classic.

describe("renderMarkdown — review 15 (allowlist + no egress)", () => {
  /** Tags the transcript must never emit, whatever the model writes. */
  const ABSENT_TAGS = [
    "script",
    "iframe",
    "object",
    "embed",
    "link",
    "style",
    "form",
    "input",
    "button",
    "base",
    "meta",
    "video",
    "audio",
    "source",
    "track",
    "svg",
    "math",
    "template",
    "noscript",
    "details",
    "img",
  ];

  function doc(html: string): Document {
    return new DOMParser().parseFromString(html, "text/html");
  }

  /** Every attribute on every live element — escaped text never appears here. */
  function liveAttrs(html: string): Attr[] {
    return Array.from(doc(html).querySelectorAll("*")).flatMap((el) =>
      Array.from(el.attributes),
    );
  }

  function expectNoLiveHandlers(html: string): void {
    for (const attr of liveAttrs(html)) {
      expect(
        attr.name.toLowerCase().startsWith("on"),
        `${attr.name} must not survive as a live attribute`,
      ).toBe(false);
    }
  }

  it("emits no <img> and no [src] at all — model output cannot trigger a fetch", async () => {
    const html = await renderMarkdown(
      [
        "![beacon](https://tracker.example/pixel.png)",
        "",
        '<img src="https://tracker.example/p.png" alt="remote">',
        "",
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="bomb">',
        "",
        '<img src=x onerror="alert(1)">',
      ].join("\n"),
    );
    const parsed = doc(html);
    // The tracking pixel, the remote file and the data:-URI render bomb are
    // all the same finding: a rendering path that fetches. There is no proxy
    // to mediate one, so none may exist (the D3 egress rule, applied here).
    expect(parsed.querySelectorAll("img").length).toBe(0);
    expect(parsed.querySelectorAll("[src]").length).toBe(0);
    for (const attr of liveAttrs(html)) {
      expect(attr.value, `${attr.name} points at the tracker`).not.toContain(
        "tracker.example",
      );
    }
    expectNoLiveHandlers(html);
  });

  it("strips every tag outside the allowlist but keeps the message", async () => {
    const html = await renderMarkdown(
      [
        "# head",
        "",
        "para **b** *i* ~~gone~~ `c`",
        "",
        "- one",
        "",
        "> quote",
        "",
        "<s>struck</s>",
        "",
        "| a | b |",
        "| --- | ---: |",
        "| 1 | 2 |",
        "",
        "<svg onload=alert(1)></svg>",
        "<math><mtext>x</mtext></math>",
        '<video src="https://evil.example/v.mp4"></video>',
        '<audio src="https://evil.example/a.mp3"></audio>',
        '<source src="https://evil.example/s.mp4">',
        '<base href="https://evil.example/">',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        '<link rel="stylesheet" href="https://evil.example/x.css">',
        "<details open><summary>hidden</summary></details>",
        '<form action="https://evil.example"><button>go</button></form>',
        '<object data="https://evil.example/o"></object>',
        '<embed src="https://evil.example/e">',
        "<template><img src=x onerror=alert(1)></template>",
      ].join("\n"),
    );
    const parsed = doc(html);
    for (const tag of ABSENT_TAGS) {
      expect(parsed.querySelectorAll(tag).length, `${tag} must not survive`).toBe(0);
    }
    // …and without over-stripping: this is the structure the transcript
    // renders every day. An allowlist that eats the message is not a fix.
    expect(parsed.querySelector("h1")?.textContent).toBe("head");
    expect(parsed.querySelector("strong")?.textContent).toBe("b");
    expect(parsed.querySelector("del")?.textContent).toBe("gone");
    expect(parsed.querySelector("li")?.textContent).toBe("one");
    expect(parsed.querySelector("blockquote")?.textContent).toContain("quote");
    // `s` is styled by styles.css (`.markdown-body s`) — the allowlist and
    // the stylesheet must agree on what renders.
    expect(parsed.querySelector("s")?.textContent).toBe("struck");
    expect(parsed.querySelector("td")?.textContent).toBe("1");
    expect(parsed.querySelector('td[align="right"]')?.textContent).toBe("2");
    for (const attr of liveAttrs(html)) {
      expect(attr.value, `${attr.name} points at the hostile origin`).not.toContain(
        "evil.example",
      );
    }
    expectNoLiveHandlers(html);
  });

  it("strips javascript: hrefs through entity, tab, newline and case tricks", async () => {
    const html = await renderMarkdown(
      [
        "[md](javascript:alert(1))",
        "",
        "[ok](https://example.com/ok)",
        "",
        '<a href="jav&#x09;ascript:alert(1)">tab</a>',
        "",
        '<a href="java\nscript:alert(1)">newline</a>',
        "",
        '<a href="&#106;&#97;&#118;&#97;script:alert(1)">entity</a>',
        "",
        '<a href="JaVaScRiPt:alert(1)">case</a>',
        "",
        '<a href=" \tjavascript:alert(1)">leading ws</a>',
      ].join("\n\n"),
    );
    const parsed = doc(html);
    const hrefs = Array.from(parsed.querySelectorAll("a")).map(
      (a) => a.getAttribute("href") ?? "",
    );
    // The honest link still renders — the allowlist is not a link-eater.
    expect(hrefs).toContain("https://example.com/ok");
    for (const href of hrefs) {
      // Mirror DOMPurify's whitespace test: collapse it out, then compare —
      // `jav\tascript:` must collapse to `javascript:` here too.
      const scheme = href.replace(/\s+/g, "").toLowerCase();
      expect(scheme.startsWith("javascript:"), `${href} must not survive`).toBe(false);
    }
    expectNoLiveHandlers(html);
  });

  it("strips data:text/html hrefs — a data: navigation is a script escape hatch", async () => {
    const html = await renderMarkdown(
      [
        '<a href="data:text/html,<script>alert(1)</script>">raw</a>',
        "",
        "[md](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
        "",
        '<a href="data:image/png;base64,iVBORw0KGgo=">data img</a>',
      ].join("\n"),
    );
    const parsed = doc(html);
    for (const href of Array.from(parsed.querySelectorAll("a")).map((a) =>
      (a.getAttribute("href") ?? "").toLowerCase(),
    )) {
      expect(href.startsWith("data:"), `${href} must not survive`).toBe(false);
    }
    expect(parsed.querySelectorAll("script").length).toBe(0);
    expectNoLiveHandlers(html);
  });

  it("kills svg- and math-borne script (foreign namespaces were live under the blocklist)", async () => {
    const html = await renderMarkdown(
      [
        "<svg><script>alert(1)</script></svg>",
        "",
        '<svg/onload="alert(1)">',
        "",
        '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
        "",
        '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>',
        "",
        "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
      ].join("\n"),
    );
    const parsed = doc(html);
    expect(parsed.querySelectorAll("svg").length).toBe(0);
    expect(parsed.querySelectorAll("math").length).toBe(0);
    expect(parsed.querySelectorAll("img").length).toBe(0);
    expect(parsed.querySelectorAll("script").length).toBe(0);
    expectNoLiveHandlers(html);
  });

  it("never lets a style attribute or a <style> block survive (expression/url vectors)", async () => {
    const html = await renderMarkdown(
      [
        '<div style="width:expression(alert(1))">x</div>',
        "",
        '<p style="background:url(javascript:alert(1))">y</p>',
        "",
        '<span style="-moz-binding:url(https://evil.example/x.xml)">z</span>',
        "",
        '<td style="color:red">t</td>',
        "",
        "<style>body{display:none}</style>",
      ].join("\n"),
    );
    const parsed = doc(html);
    expect(parsed.querySelectorAll("style").length).toBe(0);
    for (const el of Array.from(parsed.querySelectorAll("*"))) {
      expect(
        el.hasAttribute("style"),
        `${el.tagName} must not carry a style attribute`,
      ).toBe(false);
    }
    expect(html).not.toContain("expression(");
  });

  it("holds the </script> breakout inert — in a fence and as raw text", async () => {
    const html = await renderMarkdown(
      [
        "```html",
        "</script><img src=x onerror=alert(1)>",
        "```",
        "",
        "</script><script>alert(1)</script>",
      ].join("\n"),
    );
    const parsed = doc(html);
    expect(parsed.querySelectorAll("script").length).toBe(0);
    expect(parsed.querySelectorAll("img").length).toBe(0);
    expectNoLiveHandlers(html);
    // The fence content still renders — as text, where `</script>` is inert.
    expect(parsed.querySelector("code")?.textContent).toContain("</script>");
  });

  it("strips data-* — the host's own markers cannot be forged by the model", async () => {
    // `codeblocks.ts` treats data-codeblock/data-highlighted as trusted state
    // (skip a block, skip a re-highlight). A model that sets them itself could
    // suppress the header pass, so they belong to the host, not to the input.
    const html = await renderMarkdown(
      '<pre data-codeblock data-highlighted><code class="language-js">x</code></pre>',
    );
    const parsed = doc(html);
    expect(parsed.querySelector("[data-codeblock]")).toBeNull();
    expect(parsed.querySelector("[data-highlighted]")).toBeNull();
    // `class` survives: the language label reads `language-*` from it.
    expect(parsed.querySelector("pre > code")?.getAttribute("class")).toBe("language-js");
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