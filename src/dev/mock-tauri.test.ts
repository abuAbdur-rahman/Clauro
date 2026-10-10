// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { invoke } from "./mock-tauri";

/**
 * The browser harness has no Rust to publish to, so `artifact_publish` has to
 * answer with something the frame can actually load — a `data:` URL carrying
 * the document — while keeping the failure half of the contract loud: an
 * empty document or an unknown command rejects rather than rendering as a
 * blank frame (D123, UI-GUIDE Step 1).
 */

describe("browser harness artifact_publish (D123)", () => {
  it("answers with a data: URL that carries the document", async () => {
    const doc = '<!doctype html><html><body><p>harness</p></body></html>';
    const url = await invoke("artifact_publish", { nonce: "n1", doc });
    expect(typeof url).toBe("string");
    const text = String(url);
    expect(text.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(text.slice("data:text/html;charset=utf-8,".length))).toBe(doc);
  });

  it("refuses an empty document instead of serving a blank frame", async () => {
    await expect(
      invoke("artifact_publish", { nonce: "n1", doc: "   " }),
    ).rejects.toThrow(/empty artifact document/);
  });

  it("refuses a missing nonce — the URL is built from it", async () => {
    await expect(
      invoke("artifact_publish", { nonce: "", doc: "<p>x</p>" }),
    ).rejects.toThrow(/missing nonce/);
  });

  it("still rejects unknown commands loudly", async () => {
    await expect(invoke("no_such_command")).rejects.toThrow(/has no mock for invoke/);
  });
});
