// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  FRAME_TO_HOST,
  HOST_TO_FRAME,
  hostSide,
  isAllowed,
  parseFrameMessage,
  send,
  validHandshake,
  wireInbound,
  type HostLog,
} from "./channel";
import { setRenderNonce } from "./store";

/**
 * The handshake is the whole of D6, and it has three independent properties,
 * so it has three independent tests: the window-level message is validated
 * for origin AND source, the transferred port is the capability afterwards
 * (SPEC §4.4 A5: port messages carry an empty origin and a null source, so
 * per-message origin validation is not implementable and the allowlist is the
 * gate), and nothing off the allowlist is acted on in either direction.
 */

/** jsdom refuses a non-MessagePort `source`, so the fields are set directly. */
function helloFrom(
  origin: string,
  source: unknown,
  data: unknown = { type: "artifact.hello" },
): Event {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "origin", { value: origin });
  Object.defineProperty(event, "source", { value: source });
  return event;
}

/** A window that is provably not the one we sandboxed. */
const impostor = { name: "impostor-window" } as unknown;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Port delivery is a task-queue hop per message, and one `tick()` is only
 * enough when the runner is idle. Under CI load the hop lands late and a
 * fixed tick asserts too early — exactly the flake that failed Windows CI.
 * Poll for the expected state instead (bounded, 1s).
 */
async function untilSettled(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`port messages never settled: ${what}`);
}

describe("window-level gate (D6)", () => {
  it("accepts origin \"null\" from the frame's own window", () => {
    expect(validHandshake({ origin: "null", source: window }, window)).toBe(true);
  });

  it("refuses any other source, even at the right origin", () => {
    expect(validHandshake({ origin: "null", source: impostor }, window)).toBe(false);
  });

  it("refuses any non-null origin, including the app's own", () => {
    // A frame that kept a real origin is not the sandbox we promised (D2):
    // the document is served from the app's own origin (D123), so it would
    // report exactly that without the `sandbox` attribute — which is why the
    // attribute, not the transport, is the boundary.
    for (const origin of ["", "https://tauri.localhost", "http://localhost:1420", "null "]) {
      expect(validHandshake({ origin, source: window }, window)).toBe(false);
    }
  });
});

describe("allowlist, both directions (D6)", () => {
  it("is a closed list, and each direction has its own", () => {
    expect([...FRAME_TO_HOST]).toEqual([
      "artifact.hello",
      "artifact.log",
      "artifact.error",
      "artifact.nav_blocked",
    ]);
    expect([...HOST_TO_FRAME]).toEqual(["artifact.boot", "artifact.dispose"]);
  });

  it("refuses host-shaped names arriving from the frame", () => {
    for (const type of [
      "artifact.eval",
      "artifact.read",
      "artifact.invoke",
      "__TAURI_INTERNALS__.invoke",
      "hello",
      "",
    ]) {
      expect(isAllowed(FRAME_TO_HOST, type)).toBe(false);
    }
    expect(isAllowed(FRAME_TO_HOST, "artifact.log")).toBe(true);
    // A name the frame may send is not a host command: the host does not
    // accept "artifact.hello" arriving up its own direction.
    expect(isAllowed(HOST_TO_FRAME, "artifact.hello")).toBe(false);
  });

  it("send() throws rather than posting an unlisted message", () => {
    const channel = new MessageChannel();
    const notAllowed = { type: "artifact.nope" } as unknown as { type: "artifact.boot" };
    expect(() => {
      send(channel.port2, notAllowed);
    }).toThrow(/allowlist/i);
    expect(() => {
      send(channel.port2, { type: "artifact.boot" });
    }).not.toThrow();
  });
});

describe("inbound gate on the transferred port", () => {
  it("logs allowlisted messages and drops everything else silently", async () => {
    const logs: HostLog[] = [];
    const onReady = vi.fn();
    const channel = new MessageChannel();
    wireInbound(channel.port1, {
      onLog: (l) => {
        logs.push(l);
      },
      onReady,
    });

    channel.port2.postMessage({ type: "artifact.hello" });
    channel.port2.postMessage({ type: "artifact.log", level: "warn", text: "hi" });
    channel.port2.postMessage({ type: "artifact.error", text: "boom" });
    await untilSettled(
      () => onReady.mock.calls.length === 1 && logs.length === 2,
      "hello + two allowlisted logs",
    );
    expect(onReady).toHaveBeenCalledOnce();
    expect(logs).toEqual([
      { level: "warn", text: "hi" },
      { level: "error", text: "boom" },
    ]);

    channel.port2.postMessage({ type: "artifact.eval", code: "1" });
    channel.port2.postMessage({ type: "artifact.read", path: "C:/Users" });
    channel.port2.postMessage("artifact.log");
    channel.port2.postMessage(null);
    // Negative assertions cannot poll: absence has no arrival event. The
    // allowlisted traffic above already proved the channel flows, so a short
    // pause is enough to catch anything the spoofs would (wrongly) trigger.
    await tick();
    await tick();
    // No log, no throw, no reply: an off-allowlist name is indistinguishable
    // from no message at all.
    expect(logs).toHaveLength(2);
  });
});

describe("host side wiring", () => {
  it("transfers the port to the frame after a valid hello", async () => {
    const channel = new MessageChannel();
    const boots: unknown[] = [];
    // The spy sees the dispatched hello too, so it records only the
    // host's own outbound message.
    const spy = vi.fn((e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (data?.type === "artifact.boot") boots.push(data);
    });
    window.addEventListener("message", spy);
    const host = hostSide({
      frameWindow: window,
      createChannel: () => channel,
      onLog: () => undefined,
      expectedNonce: "render-1",
    });

    window.dispatchEvent(helloFrom("null", window, { type: "artifact.hello", nonce: "render-1" }));
    // `postMessage` to the frame's window is async delivery: poll for the
    // one host→frame message instead of guessing a tick count.
    await untilSettled(() => boots.length === 1, "artifact.boot delivery");
    // The one host→frame message, delivered to the frame's window.
    expect(boots).toEqual([{ type: "artifact.boot" }]);
    window.removeEventListener("message", spy);
    host.dispose();
  });

  it("a refused hello transfers nothing and observes nothing", async () => {
    const logs: HostLog[] = [];
    const onReady = vi.fn();
    const channel = new MessageChannel();
    const created = vi.fn(() => channel);
    const boots: unknown[] = [];
    // The spy sees the dispatched hello too, so it records only the
    // host's own outbound message.
    const spy = vi.fn((e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (data?.type === "artifact.boot") boots.push(data);
    });
    window.addEventListener("message", spy);
    const host = hostSide({
      frameWindow: window,
      createChannel: created,
      onLog: (l) => {
        logs.push(l);
      },
      onReady,
      expectedNonce: "render-1",
    });

    window.dispatchEvent(
      helloFrom("null", impostor, { type: "artifact.hello", nonce: "render-1" }),
    );
    await tick();

    // The validity check and the channel creation are one step: a refused
    // hello must not even allocate a channel (audit 14, NIT).
    expect(created).not.toHaveBeenCalled();
    expect(boots).toEqual([]);
    expect(logs).toEqual([]);
    expect(onReady).not.toHaveBeenCalled();
    window.removeEventListener("message", spy);
    host.dispose();
  });

  it("a second hello does not re-open the channel", async () => {
    const created = vi.fn(() => new MessageChannel());
    const host = hostSide({
      frameWindow: window,
      createChannel: created,
      onLog: () => undefined,
      expectedNonce: "render-1",
    });
    window.dispatchEvent(helloFrom("null", window, { type: "artifact.hello", nonce: "render-1" }));
    await tick();
    window.dispatchEvent(helloFrom("null", window, { type: "artifact.hello", nonce: "render-1" }));
    await tick();
    expect(created).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("the listener rides the shell's window, never the frame's (D122)", async () => {
    // An opaque frame's window is cross-origin from the shell: attaching the
    // host listener there is precisely the access the sandbox refuses (D2).
    // The frame speaks to `parent`, so the hello arrives on the shell's own
    // window with origin "null" and `source === frameWindow` — the two things
    // `validHandshake` compares. jsdom has no opaque origins, so the origin
    // is forced the way every other test in this file forces it.
    const el = document.createElement("iframe");
    document.body.appendChild(el);
    const frameWindow = el.contentWindow;
    if (!frameWindow) throw new Error("no frame window");
    const boots: unknown[] = [];
    // The boot is posted TO the frame's window, so the observer sits there.
    frameWindow.addEventListener("message", (e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (data?.type === "artifact.boot") boots.push(data);
    });
    const channel = new MessageChannel();
    const host = hostSide({
      frameWindow,
      createChannel: () => channel,
      onLog: () => undefined,
      expectedNonce: "render-1",
    });

    window.dispatchEvent(
      helloFrom("null", frameWindow, { type: "artifact.hello", nonce: "render-1" }),
    );
    await untilSettled(() => boots.length === 1, "boot delivered into the frame window");
    expect(boots).toEqual([{ type: "artifact.boot" }]);
    host.dispose();
    el.remove();
  });
});

describe("the hello is bound to the document this host published (D6/D123)", () => {
  it("refuses a hello carrying a foreign nonce", async () => {
    const created = vi.fn(() => new MessageChannel());
    const boots: unknown[] = [];
    const spy = vi.fn((e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (data?.type === "artifact.boot") boots.push(data);
    });
    window.addEventListener("message", spy);
    const host = hostSide({
      frameWindow: window,
      createChannel: created,
      onLog: () => undefined,
      expectedNonce: "render-1",
    });

    window.dispatchEvent(helloFrom("null", window, { type: "artifact.hello", nonce: "other" }));
    await tick();
    window.dispatchEvent(helloFrom("null", window, { type: "artifact.hello" }));
    await tick();
    window.dispatchEvent(
      helloFrom("null", window, { type: "artifact.hello", nonce: 42 }),
    );
    await tick();

    // A page the frame navigated to can say hello with origin "null" from the
    // frame's own window — everything the old gate checked — but it cannot
    // name the nonce of the document the host built.
    expect(created).not.toHaveBeenCalled();
    expect(boots).toEqual([]);
    window.removeEventListener("message", spy);
    host.dispose();
  });

  it("uses the render nonce prepare recorded when no explicit one is passed", async () => {
    setRenderNonce("recorded-1");
    const created = vi.fn(() => new MessageChannel());
    const boots: unknown[] = [];
    const spy = vi.fn((e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (data?.type === "artifact.boot") boots.push(data);
    });
    window.addEventListener("message", spy);
    const host = hostSide({ frameWindow: window, createChannel: created, onLog: () => undefined });

    window.dispatchEvent(helloFrom("null", window, { type: "artifact.hello" }));
    await tick();
    expect(created).not.toHaveBeenCalled();

    window.dispatchEvent(
      helloFrom("null", window, { type: "artifact.hello", nonce: "recorded-1" }),
    );
    await untilSettled(() => boots.length === 1, "boot for the recorded render nonce");
    expect(boots).toEqual([{ type: "artifact.boot" }]);
    window.removeEventListener("message", spy);
    host.dispose();
    setRenderNonce(null);
  });

  it("with no nonce recorded anywhere, nothing is handed a port", async () => {
    setRenderNonce(null);
    const created = vi.fn(() => new MessageChannel());
    const host = hostSide({ frameWindow: window, createChannel: created, onLog: () => undefined });
    window.dispatchEvent(helloFrom("null", window, { type: "artifact.hello", nonce: "" }));
    await tick();
    expect(created).not.toHaveBeenCalled();
    host.dispose();
  });

  it("dispose closes the port it started", async () => {
    const logs: HostLog[] = [];
    const channel = new MessageChannel();
    const closed = vi.spyOn(channel.port1, "close");
    const boots: unknown[] = [];
    const spy = vi.fn((e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (data?.type === "artifact.boot") boots.push(data);
    });
    window.addEventListener("message", spy);
    const host = hostSide({
      frameWindow: window,
      createChannel: () => channel,
      onLog: (l) => {
        logs.push(l);
      },
      expectedNonce: "render-1",
    });
    window.dispatchEvent(helloFrom("null", window, { type: "artifact.hello", nonce: "render-1" }));
    await untilSettled(() => boots.length === 1, "boot before dispose");
    expect(closed).not.toHaveBeenCalled();

    host.dispose();
    // The started port is ours to close: a disposed host keeps no channel
    // that could still deliver a frame message into the shell.
    expect(closed).toHaveBeenCalledOnce();
    window.removeEventListener("message", spy);
  });
});

describe("wire messages are Zod-validated (AGENTS §5)", () => {
  it("accepts the closed set and strips everything off it", () => {
    const parsed = parseFrameMessage({
      type: "artifact.log",
      level: "warn",
      text: "hi",
      invoke: "artifact.eval",
      code: "1",
    });
    expect(parsed).toEqual({ type: "artifact.log", level: "warn", text: "hi" });
  });

  it("drops anything whose type is missing or not on the allowlist", () => {
    for (const data of [
      null,
      "artifact.log",
      42,
      {},
      { type: "artifact.eval" },
      { type: "__TAURI_INTERNALS__.invoke" },
      { type: "" },
    ]) {
      expect(parseFrameMessage(data)).toBeNull();
    }
  });

  it("keeps the sound coercions: a bad level or text never drops the message", () => {
    expect(parseFrameMessage({ type: "artifact.log", level: 5, text: { deep: true } })).toEqual({
      type: "artifact.log",
      level: undefined,
      text: "",
    });
    expect(parseFrameMessage({ type: "artifact.hello" })).toEqual({ type: "artifact.hello" });
  });

  it("bounds the text slice on the way through the port", async () => {
    const logs: HostLog[] = [];
    const onReady = vi.fn();
    const channel = new MessageChannel();
    wireInbound(channel.port1, {
      onLog: (l) => {
        logs.push(l);
      },
      onReady,
    });
    channel.port2.postMessage({ type: "artifact.log", level: "info", text: "x".repeat(600) });
    await untilSettled(() => logs.length === 1, "long text arrives");
    expect(logs[0].text).toHaveLength(500);
    channel.port1.close();
    channel.port2.close();
  });
});