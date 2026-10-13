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
 * is a closed allowlist per direction, parsed with Zod (AGENTS §5: a schema
 * at every boundary). Anything off it is dropped without action, log, or
 * reply.
 */
import { z } from "zod";
import { getRenderNonce } from "./store";

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

/**
 * The frame→host payload, as a schema rather than a guard chain.
 *
 * The coercions the hand-rolled guard got right are kept as coercions: an
 * unknown level falls back to `info`, a non-string text to `""` — the message
 * the frame meant to send still arrives. What changes is the closed set
 * itself: `type` is an enum, unknown keys are stripped, and `nonce` is
 * bounded, so nothing but the six fields on the wire ever reaches a handler.
 */
const FrameMessageSchema = z.object({
  type: z.enum(FRAME_TO_HOST),
  level: z.enum(["info", "warn", "error"]).optional().catch(undefined),
  text: z
    .string()
    .transform((value) => value.slice(0, 500))
    .optional()
    .catch(""),
  nonce: z.string().max(256).optional().catch(undefined),
});

export type FrameMessageInput = z.infer<typeof FrameMessageSchema>;

/** Parse one frame→host payload. `null` means dropped, never partially read. */
export function parseFrameMessage(data: unknown): FrameMessageInput | null {
  const parsed = FrameMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
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
  // app's own origin, which is exactly what the served document (D123) would
  // report if the `sandbox` attribute were ever dropped.
  if (event.origin !== "null") return false;
  // Origin alone is not enough: every opaque-origin window also reports
  // "null", so only identity proves which frame spoke.
  return event.source === frameWindow;
}

/** Hand the port to the frame, with the one host→frame boot message. */
export function bootChannel(frameWindow: Window, port: MessagePort): void {
  frameWindow.postMessage({ type: "artifact.boot" }, "*", [port]);
}

/** The inbound gate: the schema, because the port carries no origin. */
export function wireInbound(
  port: MessagePort,
  handlers: { onLog: (log: HostLog) => void; onReady?: (() => void) | undefined },
): void {
  port.onmessage = (event: MessageEvent) => {
    const incoming = parseFrameMessage(event.data);
    if (incoming === null) return;
    // The schema already bounded it: text is a string of at most 500 or it
    // is nothing, and an object where a log line belongs never reaches a log
    // file as `[object Object]`.
    const text = incoming.text ?? "";
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
  /**
   * The nonce of the document this host published. Defaults to the render
   * nonce `prepareArtifact` recorded; when nothing is recorded (`null`) the
   * handshake is refused — no document, no channel.
   */
  expectedNonce?: string;
}

export interface HostSide {
  dispose: () => void;
}

export function hostSide(options: HostSideOptions): HostSide {
  const createChannel = options.createChannel ?? (() => new MessageChannel());
  let open = false;
  let started: MessagePort | null = null;

  const listener = (event: Event) => {
    const message = event as MessageEvent;
    const incoming = parseFrameMessage(message.data);
    // Validate *everything* before creating anything (audit 14): schema,
    // origin, source and render nonce are checked first, so a refused hello
    // never allocates a channel and check-and-transfer is one step.
    if (incoming === null || incoming.type !== "artifact.hello") return;
    // One handshake per frame: a second hello must not re-open the channel.
    if (open) return;
    if (!validHandshake(message, options.frameWindow)) return;
    // The nonce binds the hello to the document this host built (D6/D123).
    // A page the frame navigated to can copy every other field — it reads
    // "null" origin and reports the frame's own window as source — but it
    // cannot name a nonce it was never sent.
    const expected = options.expectedNonce ?? getRenderNonce();
    if (expected === null || expected === "" || incoming.nonce !== expected) return;

    open = true;
    const channel = createChannel();
    started = channel.port1;
    wireInbound(channel.port1, { onLog: options.onLog, onReady: options.onReady });
    bootChannel(options.frameWindow, channel.port2);
  };

  // The listener rides the SHELL's own window, never the frame's: an opaque
  // frame's window is cross-origin, and reaching into it is exactly what the
  // sandbox refuses (D2, D122). The frame speaks to `parent`
  // (frame-runtime.js), so the hello arrives here with origin "null" and
  // `source === frameWindow` — the two things `validHandshake` compares.
  window.addEventListener("message", listener);
  return {
    dispose: () => {
      window.removeEventListener("message", listener);
      open = false;
      // The started port is ours: a disposed host must not keep a channel
      // that could still deliver a frame message into the shell.
      started?.close();
      started = null;
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