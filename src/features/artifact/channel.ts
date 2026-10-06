/**
 * Host side of the artifact channel (D6, SPEC §4.4 A5).
 *
 * The handshake is the whole boundary, and it happens in two steps that must
 * not be confused with each other.
 *
 * **1. The window-level message.** The frame says hello on its own `window`;
 * the host checks the origin **and** the source before anything else happens.
 * The opaque origin is the literal string `"null"` (D2), and the source must be
 * the frame's own `contentWindow`. Either check failing leaves the frame inert:
 * no port, no listeners, nothing observed.
 *
 * **2. The transferred port.** Only then does the parent post the port across.
 * Target origin is `"*"` and has to be: an opaque origin cannot be named, so
 * there is no narrower value available. That is not a hole — the message is
 * posted *to the frame's window object*, never broadcast, and from this point
 * the port is the capability.
 *
 * On the port, per-message origin validation is **not implementable by
 * anyone**: a message delivered on a port carries an empty origin and a null
 * source (HTML spec; confirmed by the 001 spike — SPEC A5). What replaces it
 * is a closed allowlist per direction. Anything off it is dropped without
 * action, log, or reply.
 */

export const FRAME_TO_HOST = [
  "artifact.hello",
  "artifact.log",
  "artifact.error",
  "artifact.nav_blocked",
] as const;

export const HOST_TO_FRAME = ["artifact.boot", "artifact.dispose"] as const;

export type FrameMessage = (typeof FRAME_TO_HOST)[number];
export type HostMessage = (typeof HOST_TO_FRAME)[number];

/** One line the artifact wants the host to record. */
export interface HostLog {
  level: "info" | "warn" | "error";
  text: string;
}

export function isAllowed(list: readonly string[], type: unknown): boolean {
  return typeof type === "string" && list.includes(type);
}

/** The window-level gate. Origin first, then identity. */
export function validHandshake(
  event: { origin: string; source: unknown },
  frameWindow: unknown,
): boolean {
  // A sandboxed frame reports the opaque origin as the string "null".
  // Anything else means it is not the frame we sandboxed (D2) — including the
  // app's own origin, which is exactly what `srcdoc` would hand us if the
  // `sandbox` attribute were ever dropped.
  if (event.origin !== "null") return false;
  // Origin alone is not enough: every opaque-origin window also reports
  // "null", so only identity proves which frame spoke.
  return event.source === frameWindow;
}

/** Hand the port to the frame, with the one host→frame boot message. */
export function bootChannel(frameWindow: Window, port: MessagePort): void {
  frameWindow.postMessage({ type: "artifact.boot" }, "*", [port]);
}

/** The inbound gate: allowlist only, because the port carries no origin. */
export function wireInbound(
  port: MessagePort,
  handlers: { onLog: (log: HostLog) => void; onReady?: () => void },
): void {
  port.onmessage = (event: MessageEvent) => {
    const incoming = event.data as
      | { type?: unknown; level?: unknown; text?: unknown }
      | null;
    if (incoming === null || typeof incoming !== "object") return;
    if (!isAllowed(FRAME_TO_HOST, incoming.type)) return;
    // Text is a string or it is nothing: an object where a log line belongs is
    // not stringified into `[object Object]` and never reaches a log file.
    const text = typeof incoming.text === "string" ? incoming.text.slice(0, 500) : "";
    switch (incoming.type) {
      case "artifact.hello":
        handlers.onReady?.();
        break;
      case "artifact.log":
      case "artifact.nav_blocked":
        handlers.onLog({ level: asLevel(incoming.level), text });
        break;
      case "artifact.error":
        handlers.onLog({ level: "error", text });
        break;
      default:
        break;
    }
  };
  // A port that is never started queues messages forever. Setting `onmessage`
  // implies `start()` in the HTML spec, but relying on that means this module
  // silently stops working under any engine that does not do it (jsdom does
  // not, and its absence is how the tests found it). Explicit is correct
  // everywhere and free.
  port.start();
}

/** Levels are a closed set too: an artifact may not invent one. */
function asLevel(value: unknown): HostLog["level"] {
  return value === "warn" || value === "error" ? value : "info";
}

export interface HostSideOptions {
  frameWindow: Window;
  onLog: (log: HostLog) => void;
  onReady?: () => void;
  /** Injected so a test can supply its own channel without a browser. */
  createChannel?: () => MessageChannel;
}

export interface HostSide {
  dispose: () => void;
}

export function hostSide(options: HostSideOptions): HostSide {
  const createChannel = options.createChannel ?? (() => new MessageChannel());
  let open = false;

  const listener = (event: Event) => {
    const message = event as MessageEvent;
    const data = message.data as { type?: unknown } | null;
    if (!isAllowed(FRAME_TO_HOST, data?.type)) return;
    // One handshake per frame: a second hello must not re-open the channel.
    if (open) return;

    const channel = createChannel();
    if (!validHandshake(message, options.frameWindow)) {
      channel.port1.close();
      channel.port2.close();
      return;
    }
    open = true;
    wireInbound(channel.port1, { onLog: options.onLog, onReady: options.onReady });
    bootChannel(options.frameWindow, channel.port2);
  };

  const target = options.frameWindow as unknown as EventTarget;
  target.addEventListener("message", listener);
  return {
    dispose: () => {
      target.removeEventListener("message", listener);
      open = false;
    },
  };
}

/**
 * Host → frame. Throws on an unlisted type: a programming error here is a
 * capability mistake, and a silent no-op would hide it.
 */
export function send(port: MessagePort, message: { type: HostMessage }): void {
  if (!isAllowed(HOST_TO_FRAME, message.type)) {
    throw new Error(`message not on the host→frame allowlist: ${message.type}`);
  }
  port.postMessage(message);
}