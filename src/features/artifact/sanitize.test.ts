// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./sanitize";
import SANITIZE_SOURCE from "./sanitize.ts?raw";

/**
 * SVG is markup the model wrote, and SVG can carry script. DOMPurify runs only
 * in this path — it is never imported by the shell's own code (D4).
 */

describe("SVG sanitisation (D4)", () => {
  it("strips a script element and keeps the drawing", async () => {
    const out = await sanitizeSvg(
      '<svg viewBox="0 0 10 10"><script>fetch("https://x")</script><rect width="10" height="10"/></svg>',
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.svg).not.toMatch(/<script/i);
    expect(out.svg).not.toMatch(/fetch\(/);
    expect(out.svg).toMatch(/<rect/);
    // `viewBox` surviving is a real assertion, not decoration: DOMPurify drops
    // it on the `ALLOWED_URI_REGEXP` code path, and a scaled drawing without
    // it renders broken.
    expect(out.svg).toMatch(/viewBox/);
  });

  it("strips event handlers, which fire without any script element", async () => {
    const out = await sanitizeSvg('<svg onload="alert(1)"><circle onclick="x()" r="2"/></svg>');
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.svg).not.toMatch(/onload/i);
    expect(out.svg).not.toMatch(/onclick/i);
    expect(out.svg).toMatch(/<circle/);
  });

  it("strips script smuggled through foreignObject", async () => {
    const out = await sanitizeSvg(
      '<svg><foreignObject><body><script>alert(1)</script></body></foreignObject></svg>',
    );
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.svg).not.toMatch(/<script/i);
  });

  it("strips javascript: urls and external references", async () => {
    const out = await sanitizeSvg(
      '<svg><a href="javascript:alert(1)"><rect width="1" height="1"/></a>' +
        '<image href="https://example.com/x.png"/></svg>',
    );
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.svg).not.toMatch(/javascript:/i);
    expect(out.svg).not.toMatch(/example\.com/);
  });

  it("refuses markup that is not an svg, with a typed error", async () => {
    const out = await sanitizeSvg("<h1>not svg</h1>");
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.message).toMatch(/svg/i);
  });

  it("is loaded dynamically, so DOMPurify stays out of the main bundle", () => {
    // A static `import DOMPurify from "dompurify"` would put ~100 KB in the
    // chunk every launch pays for. The shape of the import is the property, so
    // it is asserted from the source rather than from a build artefact that no
    // test run would have.
    const code = SANITIZE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/^import\s/m);
    expect(code).toMatch(/await import\("dompurify"\)/);
  });
});