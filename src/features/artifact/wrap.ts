/**
 * The wrapper text placed around compiled artifact code inside the frame's
 * `<script nonce>` tag (D110).
 *
 * Compiled output is CommonJS — Sucrase's `imports` transform produced it — so
 * the wrapper supplies `exports`/`module` and hands the default export to the
 * frame runtime. Two things it deliberately does **not** do:
 *
 * - no `eval` or `new Function`. The frame's `script-src` is nonce-only, with
 *   no `unsafe-eval`; the compiled code arrives as a real script element and
 *   this is the only glue it needs.
 * - no error suppression. A throw inside the artifact is reported to the host
 *   through the runtime's own channel and leaves the frame usable.
 */
export function wrapModule(code: string): string {
  return [
    "(function () {",
    '"use strict";',
    "var exports = {};",
    "var module = { exports: exports };",
    "var require = function (name) { throw new Error('artifact cannot require: ' + name); };",
    "try {",
    code,
    "} catch (error) {",
    'window.__clauroReport("artifact threw: " + (error && error.message));',
    "return;",
    "}",
    "window.__clauroRun(module.exports, document.getElementById('root'));",
    "})();",
  ].join("\n");
}