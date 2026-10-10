// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import FRAME_RUNTIME from "./frame-runtime.js?raw";
import { transformJsx } from "./compile.transform";
import { wrapModule } from "./wrap";

/**
 * The frame runtime is emitted as source text into the published artifact
 * document (D123), where no module system exists. That makes it the one piece
 * of behaviour that cannot be tested by importing it — so it is evaluated here,
 * in a real document, against the same wrapper the shipped document carries. No
 * `eval` inside the frame itself: the compiled code arrives as a nonce'd
 * `<script>` tag, and the test host has no CSP to stop it.
 */

interface FrameApi {
  h: (tag: string, props?: Record<string, unknown> | null, ...children: unknown[]) => HTMLElement;
}

interface Frame {
  win: Window;
  doc: Document;
  api: FrameApi;
}

/**
 * Boot the runtime in a **fresh frame document** per test. Any other approach
 * leaks: the runtime installs listeners on `window` and `document`, so booting
 * it N times in one document leaves N copies all answering the same event — an
 * earlier draft of this file did exactly that and one test saw sixteen hellos.
 * A fresh iframe is also the closer model: this code ships into a frame.
 */
function boot(): Frame {
  const el = document.createElement("iframe");
  document.body.appendChild(el);
  const win = el.contentWindow;
  const doc = el.contentDocument;
  if (!win || !doc) throw new Error("no frame document");
  // Evaluating the shipped text *is* the assertion: it is the only way this
  // runtime can run, and it runs in the frame document where it ships.
  runIn(win, FRAME_RUNTIME);
  const api = (win as unknown as { __clauroArtifact?: FrameApi }).__clauroArtifact;
  if (!api) throw new Error("frame runtime did not expose its API");
  return { win, doc, api };
}

/** Run compiled code the way the envelope's `<script nonce>` tag does. */
function runArtifact(frame: Frame, code: string): void {
  frame.doc.body.innerHTML = '<div id="root"></div>';
  // The browser parses this as a script element; the test host has no CSP, so
  // evaluating the identical text is the equivalent.
  runIn(frame.win, wrapModule(code));
}

/**
 * jsdom's `Window` type omits `eval`, which it does implement. Going through
 * the function constructor is the documented equivalent of a script element
 * for text that has no CSP to satisfy.
 */
function runIn(win: Window, source: string): void {
  const evaluate: unknown = Reflect.get(win, "eval");
  if (typeof evaluate !== "function") throw new Error("frame document cannot evaluate");
  const call = evaluate as (this: Window, code: string) => unknown;
  // Evaluating the frame's own script text is the assertion; see above. The
  // `no-implied-eval` rule cannot see it through `Reflect.get`, and
  // `no-unsafe-call` is satisfied by the typed alias, so no suppression is
  // needed here.
  call.call(win, source);
}

/**
 * Complete the handshake so the frame's outbound channel is observable. jsdom
 * refuses a non-`MessagePort` `source`, so the event fields are set directly —
 * which is how the runtime reads them anyway.
 */
function handshake(
  frame: Frame,
  options: { fromParent?: boolean; withPort?: boolean } = {},
): { inbound: { type: string; text?: string }[] } {
  const channel = new MessageChannel();
  const inbound: { type: string; text?: string }[] = [];
  channel.port1.onmessage = (e: MessageEvent) => {
    inbound.push(e.data as { type: string });
  };
  const event = new MessageEvent("message", { data: { type: "artifact.boot" } });
  Object.defineProperty(event, "source", {
    value: options.fromParent === false ? { name: "impostor" } : frame.win.parent,
  });
  Object.defineProperty(event, "ports", {
    value: options.withPort === false ? [] : [channel.port2],
  });
  frame.win.dispatchEvent(event);
  return { inbound };
}

/**
 * Port delivery is asynchronous, and how many turns it takes is the engine's
 * business. Poll rather than guess a tick count: a fixed `setTimeout(0)` is the
 * kind of test that passes on one engine and flakes on another.
 */
async function until(predicate: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

/** For asserting that nothing arrives: give the port a real window to arrive in. */
async function pause(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the runtime is shippable into the published document", () => {
  it("is self-contained: no imports, no requires, no network calls", () => {
    expect(FRAME_RUNTIME).not.toMatch(/^\s*import\s/m);
    expect(FRAME_RUNTIME).not.toMatch(/\brequire\s*\(/);
    expect(FRAME_RUNTIME).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|new WebSocket|EventSource/);
    // It must not be able to reach the host's bridge either.
    expect(FRAME_RUNTIME).not.toMatch(/__TAURI/);
  });
});

describe("h() builds DOM nodes directly (D110)", () => {
  it("renders a tree and sets attributes and classes", () => {
    const node = boot().api.h("h1", { class: "text-xl", id: "t", "data-x": "1" }, "hello");
    expect(node.tagName).toBe("H1");
    expect(node.getAttribute("class")).toBe("text-xl");
    expect(node.id).toBe("t");
    expect(node.dataset.x).toBe("1");
    expect(node.textContent).toBe("hello");
  });

  it("treats a string child as text, never as markup", () => {
    const node = boot().api.h("div", {}, "<img src=x onerror=alert(1)>");
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("binds on* props as listeners", () => {
    let clicks = 0;
    const node = boot().api.h("button", {
      onClick: () => {
        clicks += 1;
      },
    });
    node.dispatchEvent(new MouseEvent("click"));
    expect(clicks).toBe(1);
  });

  it("drops a javascript: href rather than rewriting it", () => {
    const { api } = boot();
    expect(api.h("a", { href: "javascript:alert(1)" }, "x").getAttribute("href")).toBeNull();
    expect(api.h("a", { href: "https://example.com" }, "x").getAttribute("href")).toBe(
      "https://example.com",
    );
  });

  it("has no string-to-markup back door", () => {
    const node = boot().api.h("div", { dangerouslySetInnerHTML: "<b>x</b>" });
    expect(node.querySelector("b")).toBeNull();
  });
});

describe("compiled artifacts run (D4)", () => {
  it("mounts a real JSX artifact and wires its interaction", () => {
    const frame = boot();
    const compiled = transformJsx(`
      export default function App() {
        let n = 0;
        return h("div", { class: "p-4" },
          h("button", { id: "inc", onClick: () => { n += 1; document.getElementById("root").textContent = String(n); } }, "+")
        );
      }
    `);
    if (compiled.kind !== "ok") throw new Error("expected ok");
    runArtifact(frame, compiled.code);

    const root = frame.doc.getElementById("root") as HTMLElement;
    const button = root.querySelector("#inc");
    expect(button).not.toBeNull();
    button?.dispatchEvent(new MouseEvent("click"));
    // The artifact's own state, observable in its own output.
    expect(root.textContent).toBe("1");
  });

  it("a throwing artifact reports itself and leaves the frame usable", async () => {
    const frame = boot();
    const { inbound } = handshake(frame);
    expect(() => {
      runArtifact(frame, "throw new Error('artifact exploded');");
    }).not.toThrow();
    await until(() => inbound.some((m) => /artifact exploded/.test(m.text ?? "")));
    expect(inbound.map((m) => m.text ?? "").join(" ")).toMatch(/artifact exploded/);
    // Still ours: the document is intact and another artifact can run.
    runArtifact(frame, "module.exports.default = h('i', {}, 'second');");
    expect(frame.doc.querySelector("i")?.textContent).toBe("second");
  });

  it("the wrapper needs no eval, so the frame needs no unsafe-eval", () => {
    expect(wrapModule("module.exports.default = h('b', {}, 'x');")).not.toMatch(
      /\beval\s*\(|new\s+Function\s*\(/,
    );
  });
});

describe("the handshake, from inside the frame (D6)", () => {
  it("claims the port and says hello", async () => {
    const { inbound } = handshake(boot());
    await until(() => inbound.length > 0);
    expect(inbound).toEqual([{ type: "artifact.hello" }]);
  });

  it("refuses a boot message from any window but the parent", async () => {
    const { inbound } = handshake(boot(), { fromParent: false });
    await pause();
    expect(inbound).toEqual([]);
  });

  it("refuses a boot message carrying no port", async () => {
    const { inbound } = handshake(boot(), { withPort: false });
    await pause();
    expect(inbound).toEqual([]);
  });

  it("buffers a report made before the port arrives, then flushes it", async () => {
    // The artifact can run before the handshake completes; a dropped first
    // error report is how a blank artifact stays unexplained.
    const frame = boot();
    frame.doc.body.innerHTML = '<div id="root"></div>';
    frame.win.dispatchEvent(new Event("error"));
    const { inbound } = handshake(frame);
    await until(() => inbound.some((m) => m.type === "artifact.hello"));
    const types = inbound.map((m) => m.type);
    expect(types).toContain("artifact.error");
    expect(types).toContain("artifact.hello");
  });
});

describe("in-frame navigation is contained (D102)", () => {
  const links =
    '<a id="out" href="https://example.com/">external</a>' +
    '<a id="js" href="javascript:alert(1)">script</a>' +
    '<a id="top" href="#x" target="_top">escape</a>' +
    '<a id="in" href="#section">fragment</a>' +
    '<form id="f" action="https://example.com/"><input name="q"></form>';

  function click(doc: Document, id: string): MouseEvent {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    (doc.getElementById(id) as HTMLAnchorElement).dispatchEvent(event);
    return event;
  }

  it("blocks an external target and reports it", async () => {
    const frame = boot();
    frame.doc.body.innerHTML = links;
    const { inbound } = handshake(frame);
    expect(click(frame.doc, "out").defaultPrevented).toBe(true);
    await until(() => inbound.some((m) => m.type === "artifact.nav_blocked"));
    expect(inbound.some((m) => m.type === "artifact.nav_blocked")).toBe(true);
    expect(inbound.map((m) => m.text ?? "").join(" ")).toMatch(/example\.com/);
  });

  it("blocks javascript: and any target that escapes the frame", () => {
    const frame = boot();
    frame.doc.body.innerHTML = links;
    handshake(frame);
    expect(click(frame.doc, "js").defaultPrevented).toBe(true);
    expect(click(frame.doc, "top").defaultPrevented).toBe(true);
  });

  it("leaves a fragment link inside the frame", () => {
    const frame = boot();
    frame.doc.body.innerHTML = links;
    handshake(frame);
    expect(click(frame.doc, "in").defaultPrevented).toBe(false);
  });

  it("blocks a form submission that would post out of the frame", async () => {
    const frame = boot();
    frame.doc.body.innerHTML = links;
    const { inbound } = handshake(frame);
    const event = new Event("submit", { bubbles: true, cancelable: true });
    (frame.doc.getElementById("f") as HTMLFormElement).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await until(() => inbound.some((m) => /form submission/.test(m.text ?? "")));
    expect(inbound.map((m) => m.text ?? "").join(" ")).toMatch(/form submission/);
  });
});

describe("handshake start (D122)", () => {
  it("says hello to its parent on start", () => {
    // The first contact is the frame's: the host has no reason to speak
    // until asked, and the frame has no port until it asks. Spying on the
    // parent's postMessage pins the direction — the host's listener sits on
    // the SHELL's window (an opaque frame's window is cross-origin, and
    // reaching in there is what the sandbox refuses), so the hello must go
    // to the parent, not to the frame's own window.
    const posted: unknown[] = [];
    const original = window.postMessage.bind(window);
    window.postMessage = (message: unknown) => {
      posted.push(message);
    };
    try {
      boot();
    } finally {
      window.postMessage = original;
    }
    expect(posted).toEqual([{ type: "artifact.hello" }]);
  });
});