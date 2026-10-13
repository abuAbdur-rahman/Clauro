/**
 * The artifact document (D2, D3, D110).
 *
 * The envelope is the only document the host ever publishes (D123), and its
 * job is to be unweakenable from the inside:
 *
 * - the CSP is a **value from Rust**, fetched per render, never written here —
 *   a policy in this repo's TypeScript would be a string the front end could
 *   choose not to send. `envelope.test.ts` asserts this file contains no
 *   directive at all, so "assembled in Rust" is checked rather than promised.
 * - the policy lands **first in `<head>`**, before any script, so artifact
 *   markup can never precede it.
 * - every script carries the nonce, including the compiled artifact's, which is
 *   why `script-src` needs no `unsafe-inline`.
 * - the frame runtime is emitted **before** the artifact's code: the
 *   navigation guard is installed before any artifact handler exists, so the
 *   artifact cannot remove it.
 */
import FRAME_RUNTIME from "./frame-runtime.js?raw";
import { wrapModule } from "./wrap";

export interface EnvelopeInput {
  /** `artifact_csp(nonce)` from Rust. Never synthesised here. */
  csp: string;
  nonce: string;
  title: string;
  /** Artifact markup with its JSX blocks already extracted. */
  markup: string;
  /** Compiled JSX blocks, empty for a purely static artifact. */
  code: string;
  /** Vendored stylesheet text. Empty until 022 fills the slot (D111). */
  css: string;
}

/** Escape the three places markup can escape its element. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Escape a `</` the HTML tokenizer would recognise as a close tag.
 *
 * Compiled code sits inside `<script nonce>`, and there it is the tokenizer —
 * not the JS parser — that decides where the element ends: `</script`,
 * `</SCRIPT`, `</script >` and `</script\n>` all end it (audit 14). `<\/script`
 * does not, and it is an ordinary string in JavaScript (`\/` is just `/`), so
 * a string, comment or regex in artifact code keeps its meaning.
 */
function escapeScriptText(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

/** The same rule for `<style ...>`, whose end tag is `</style`. */
function escapeStyleText(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

export function buildEnvelope(input: EnvelopeInput): string {
  if (input.csp.trim() === "") {
    // Refused rather than rendered: an envelope without a policy is an
    // unsandboxed artifact, and a silent fallback would hide that.
    throw new Error("artifact CSP policy is empty; refusing to build the envelope");
  }
  const nonce = escapeAttr(input.nonce);
  // The runtime echoes this value in its hello, and channel.ts validates the
  // hello against the nonce of the document it published — the binding that
  // stops a page the frame navigated to from claiming the channel (D6/D123).
  const runtime = `window.__clauroHandshakeNonce = ${JSON.stringify(input.nonce)};\n${FRAME_RUNTIME}`;
  const head = [
    '<meta http-equiv="Content-Security-Policy" content="' +
      escapeAttr(input.csp) +
      '">',
    `<title>${escapeText(input.title)}</title>`,
    input.css.trim() === ""
      ? ""
      : `<style nonce="${nonce}">${escapeStyleText(input.css)}</style>`,
    `<script nonce="${nonce}">${escapeScriptText(runtime)}</script>`,
  ]
    .filter((part) => part !== "")
    .join("\n");

  const artifact =
    input.code.trim() === ""
      ? ""
      : `<script nonce="${nonce}">\n${escapeScriptText(wrapModule(input.code))}\n</script>`;

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    head,
    "</head>",
    '<body class="p-4">',
    '<div id="root">',
    input.markup,
    "</div>",
    artifact,
    "</body>",
    "</html>",
  ].join("\n");
}