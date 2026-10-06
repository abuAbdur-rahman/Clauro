// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildEnvelope } from "./envelope";
// The source of this very module, as text. Reading it through the bundler
// keeps the test off `node:fs`, which this project does not type.
import ENVELOPE_SOURCE from "./envelope.ts?raw";

/**
 * The envelope is the artifact document. Its only job is to be unweakenable:
 * the CSP comes from Rust (D3, and D78's rule that only named directives are
 * ever disabled), the policy lands before anything else in `<head>`, and every
 * script we emit carries the nonce so `script-src` needs no `unsafe-inline`.
 */

const CSP =
  "default-src 'none'; script-src 'nonce-abc'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; connect-src 'none'; form-action 'none'; object-src 'none'";

function envelope(over: Partial<Parameters<typeof buildEnvelope>[0]> = {}): string {
  return buildEnvelope({
    csp: CSP,
    nonce: "abc",
    title: "Demo",
    markup: "<h1>static</h1>",
    code: "",
    css: "",
    ...over,
  });
}

describe("CSP placement", () => {
  it("is the first thing in head, ahead of any script or style", () => {
    const doc = envelope({ css: ".p-4{padding:1rem}" });
    const head = doc.slice(doc.indexOf("<head>"), doc.indexOf("</head>"));
    expect(head.indexOf("http-equiv")).toBeLessThan(head.indexOf("<style"));
    expect(head.indexOf("http-equiv")).toBeLessThan(head.indexOf("<script"));
  });

  it("the runtime script precedes the artifact's code", () => {
    // Otherwise the artifact could run before the navigation guard exists.
    const doc = envelope({ code: "module.exports.default = 1;" });
    expect(doc.indexOf("__clauroRun")).toBeLessThan(doc.lastIndexOf("<script"));
  });
});

describe("script nonces", () => {
  it("every script element in the document carries the nonce", () => {
    const doc = envelope({ code: "module.exports.default = 1;" });
    // Parsed, not regex-matched: the runtime's own source contains the text
    // "<script>" in a comment, and a text scan would flag that.
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    const scripts = [...parsed.querySelectorAll("script")];
    expect(scripts.length).toBeGreaterThan(1);
    for (const script of scripts) {
      expect(script.getAttribute("nonce")).toBe("abc");
    }
  });

  it("emits no inline event-handler attributes at all", () => {
    const doc = envelope({ code: "x", markup: "<h1>static</h1>" });
    expect(doc).not.toMatch(/\son[a-z]+="/);
  });
});

describe("no policy in the web app's own source", () => {
  it("no CSP directive is written in TypeScript: they all come from Rust", () => {
    // Comments are stripped first: the module explains the rule in prose, and a
    // prose mention of `connect-src` is not a policy.
    const code = ENVELOPE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const directive of [
      "connect-src",
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "frame-src",
      "unsafe-inline",
      "unsafe-eval",
    ]) {
      expect(code, directive).not.toMatch(new RegExp(directive));
    }
  });

  it("the app-side builder refuses to be handed an empty policy", () => {
    expect(() => envelope({ csp: "" })).toThrow(/policy/i);
  });
});

describe("composition", () => {
  it("keeps the artifact markup and code, and the vendored stylesheet", () => {
    const doc = envelope({
      markup: "<h1>static</h1>",
      code: "/* compiled */",
      css: ".p-4{padding:1rem}",
    });
    expect(doc).toContain("<h1>static</h1>");
    expect(doc).toContain("/* compiled */");
    expect(doc).toContain(".p-4{padding:1rem}");
    expect(doc).toContain("<title>Demo</title>");
  });

  it("a title containing markup is escaped, not injected", () => {
    const doc = envelope({ title: "</title><script>alert(1)</script>" });
    expect(doc).not.toContain("<script>alert(1)</script>");
  });
});