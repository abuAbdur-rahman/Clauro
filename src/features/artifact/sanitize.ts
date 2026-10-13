/**
 * SVG sanitisation (D4).
 *
 * SVG is markup the model wrote, and SVG can carry script: `<script>`, an
 * `onload` attribute, a `javascript:` href in an `<a>`. DOMPurify runs only
 * here — never in the shell's own code — because a sanitiser in the main
 * bundle is a sanitiser nothing else uses, and ~100 KB nobody asked for.
 *
 * The import is **dynamic** for that reason: a static import lands DOMPurify in
 * the main chunk, so every launch pays for it to sanitise an SVG that most
 * turns never produce. `D4` asks for "only in the artifact frame, not in the
 * main bundle", and this is what that costs in practice.
 *
 * HTML artifacts are **not** sanitised, and that is a decision rather than an
 * oversight: an HTML artifact's whole purpose is to run code, so stripping
 * script from it would leave nothing. Its containment is the opaque origin and
 * the CSP. SVG has no such purpose in v1 — it is a picture — so the script goes.
 */

export type SanitizeOutcome =
  | { kind: "ok"; svg: string }
  | { kind: "error"; message: string };

interface Purifier {
  sanitize: (dirty: string, config?: unknown) => string;
}

const URL_TARGET = /url\(\s*(?:"([^"]*)"|'([^']*)'|((?:[^()]|\([^()]*\))*))\s*\)/gi;

/**
 * Rewrite every `url(...)` in a `style` attribute to `none` unless its target
 * is a same-document fragment or a `data:`/`blob:` URI the CSP already allows.
 *
 * Two layers, not one (audit 14): the CSP in the frame would block a remote
 * fetch anyway, but an egress-capable style should not depend on it — and a
 * `javascript:` target is refused outright rather than left to the CSS parser.
 * `url(#g)` — gradient and filter references — is the functionality case and
 * survives untouched.
 */
function stripRemoteCssUrls(style: string): string {
  return style.replace(URL_TARGET, (_match, dq?: string, sq?: string, bare?: string) => {
    const target = (dq ?? sq ?? bare ?? "").trim().toLowerCase();
    if (target.startsWith("data:") || target.startsWith("blob:") || target.startsWith("#")) {
      return _match;
    }
    return "none";
  });
}

function stripStyleAttributes(markup: string): string {
  return markup.replace(
    /(\sstyle=")([^"]*)(")/g,
    (_match, open: string, value: string, close: string) =>
      `${open}${stripRemoteCssUrls(value)}${close}`,
  );
}

export async function sanitizeSvg(markup: string): Promise<SanitizeOutcome> {
  if (!/<\s*svg[\s>]/i.test(markup)) {
    return { kind: "error", message: "svg artifacts must be an <svg> document" };
  }
  const imported: unknown = (await import("dompurify")).default;
  // The package's default export is an instance where a window exists and a
  // factory where one does not. Both are handled; neither is assumed.
  const purifier: Purifier =
    typeof imported === "function"
      ? (imported as (win: Window) => Purifier)(window)
      : (imported as Purifier);
  // Note what is deliberately *absent*: `ALLOWED_URI_REGEXP`. Setting it puts
  // DOMPurify on a different configuration path, and on 3.x that path drops
  // camelCase SVG attributes — `viewBox` included, which silently turns every
  // scaled drawing into a broken one. The default URI regexp already refuses
  // `javascript:`, and `FORBID_ATTR` removes every href outright, so the
  // strictest configuration is also the one that renders.
  const svg = purifier.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    FORBID_TAGS: [
      "script",
      "foreignObject",
      "iframe",
      "object",
      "embed",
      "link",
      "style",
      // SMIL can rewire an attribute *after* the attribute filters ran —
      // `<set attributeName="href" ...>` — so the animation elements go
      // entirely rather than one-by-one as a DOMPurify allowlist shifts.
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
      // `<img>`/`srcset` are HTML in an svg document and an egress surface
      // the CSP would otherwise be the only thing holding (audit 14).
      "img",
      "meta",
    ],
    // No href at all: the nav guard drops external targets anyway (D102), and
    // an `xlink:href` is a fetch we would otherwise reason about per element.
    FORBID_ATTR: ["href", "xlink:href", "srcset"],
  });
  return { kind: "ok", svg: stripStyleAttributes(svg) };
}