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

describe("SMIL cannot rewire attributes after the fact (audit 14, IMPORTANT)", () => {
  it("strips animate, animateMotion, animateTransform and set", async () => {
    const out = await sanitizeSvg(
      '<svg viewBox="0 0 4 4">' +
        '<set attributeName="href" to="javascript:alert(1)"/>' +
        '<animate attributeName="href" to="javascript:alert(1)"/>' +
        '<animateTransform attributeName="transform" type="rotate" from="0" to="90"/>' +
        '<animateMotion path="M0 0 L10 10"/>' +
        '<rect width="4" height="4"/></svg>',
    );
    if (out.kind !== "ok") throw new Error("expected ok");
    // Any one of these surviving is one attribute rewrite away from an href
    // that CSP alone has to stop.
    expect(out.svg).not.toMatch(/<set[\s>]/i);
    expect(out.svg).not.toMatch(/<animate[\s>]/i);
    expect(out.svg).not.toMatch(/<animateTransform/i);
    expect(out.svg).not.toMatch(/<animateMotion/i);
    expect(out.svg).toMatch(/<rect/);
    expect(out.svg).toMatch(/viewBox/);
  });
});

describe("egress-capable markup does not rest on CSP alone (audit 14, NIT)", () => {
  it("strips <img> and srcset from the svg document", async () => {
    const out = await sanitizeSvg(
      '<svg><rect width="4"/><img src="https://evil.example/x.png" ' +
        'srcset="https://evil.example/2x.png 2x"/></svg>',
    );
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.svg).not.toMatch(/<img/i);
    expect(out.svg).not.toMatch(/srcset/i);
    expect(out.svg).not.toMatch(/evil\.example/);
    expect(out.svg).toMatch(/<rect/);
  });

  it("keeps no javascript: or remote url() in a style attribute", async () => {
    const out = await sanitizeSvg(
      '<svg><rect width="4" style="fill:url(javascript:alert(1));' +
        'background-image:url(https://evil.example/x)"/></svg>',
    );
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.svg).not.toMatch(/javascript:/i);
    expect(out.svg).not.toMatch(/https:\/\/evil\.example/);
  });

  it("leaves a same-document fragment url() alone (functionality)", async () => {
    const out = await sanitizeSvg(
      '<svg><defs><linearGradient id="g"/></defs><rect width="4" style="fill:url(#g)"/></svg>',
    );
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.svg).toContain("url(#g)");
  });
});

describe("hardening pins (audit 14, NIT: untested vectors)", () => {
  it("is idempotent: a second sanitisation changes nothing", async () => {
    const messy =
      '<svg viewBox="0 0 4 4"><script>alert(1)</script>' +
      '<set attributeName="href" to="javascript:x"/><rect width="4" onload="alert(1)"/></svg>';
    const once = await sanitizeSvg(messy);
    if (once.kind !== "ok") throw new Error("expected ok");
    const twice = await sanitizeSvg(once.svg);
    if (twice.kind !== "ok") throw new Error("expected ok");
    expect(twice.svg).toBe(once.svg);
  });

  it("a mutation (mXSS) payload never grows an event-handler attribute on reparse", async () => {
    const out = await sanitizeSvg(
      '<svg><style><img src=</style>onerror=alert(1)></style><rect width="1"/></svg>',
    );
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.svg).not.toMatch(/<style/i);
    // What the frame parses is what must stay true: no attribute starts with `on`.
    const view = new DOMParser().parseFromString(out.svg, "text/html");
    for (const el of [...view.querySelectorAll("*")]) {
      for (const attr of [...el.attributes]) {
        expect(attr.name, `${el.tagName}/${attr.name}`).not.toMatch(/^on/i);
      }
    }
  });

  it("pins the installed DOMPurify version so a range bump is a reviewed act", async () => {
    // package.json declares `^3.4.16`; without this pin a lockfile refresh can
    // move the sanitiser under us. (An exact specifier in package.json is the
    // stronger fix — out of this agent's file ownership, reported upstream.)
    const imported: unknown = await import("dompurify");
    const version =
      (imported as { version?: string }).version ??
      ((imported as { default?: { version?: string } }).default?.version ?? "");
    expect(version).toBe("3.4.16");
  });
});