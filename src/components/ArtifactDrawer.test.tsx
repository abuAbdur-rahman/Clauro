// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ArtifactDrawer } from "./ArtifactDrawer";
import { useDrawerStore } from "../features/artifact/store";
import type { prepareArtifact, PrepareResult } from "../features/artifact/prepare";

/**
 * The drawer is where a compiled artifact becomes visible, so its contract is
 * narrow and worth stating: no blank frame, ever. Every failure has to show a
 * reason, and the sandbox tokens are host-fixed (D108) with no prop that could
 * widen them.
 */

type PrepareArgs = Parameters<typeof prepareArtifact>[0];

const prepare = vi.hoisted(() => ({
  fn: vi.fn<(args: PrepareArgs) => Promise<PrepareResult>>(() =>
    Promise.resolve({ kind: "live", doc: "<!doctype html><p>doc</p>", nonce: "n1" }),
  ),
}));

vi.mock("../features/artifact/prepare", () => ({
  prepareArtifact: prepare.fn,
  newNonce: () => "n1",
}));

beforeEach(() => {
  cleanup();
  prepare.fn.mockClear();
  prepare.fn.mockResolvedValue({ kind: "live", doc: "<!doctype html><p>doc</p>", nonce: "n1" });
  useDrawerStore.getState().reset();
});

const ENGINE = { platform: "windows" as const, opaqueProven: true };

function draw(over: Partial<Parameters<typeof ArtifactDrawer>[0]> = {}) {
  return render(
    <ArtifactDrawer
      threadId="t1"
      engine={ENGINE}
      source="<h1>hi</h1>"
      mediaType="text/html"
      title="Demo"
      {...over}
    />,
  );
}

describe("ArtifactDrawer (DESIGN.md §2.4)", () => {
  it("empty renders a zero-width, chromeless column", () => {
    const { container } = draw();
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("aria-hidden")).toBe("true");
    expect(aside?.className).toMatch(/w-0/);
    expect(screen.queryByText(/compiling/i)).toBeNull();
    // Nothing to prepare, so nothing was prepared.
    expect(prepare.fn).not.toHaveBeenCalled();
  });

  it("compiling says compiling, then prepares", async () => {
    useDrawerStore.getState().setCompiling("t1", "a1");
    draw({ title: "D" });
    expect(screen.getByText(/compiling/i)).not.toBeNull();
    expect(screen.queryByTitle("artifact-frame")).toBeNull();
    await waitFor(() => {
      expect(prepare.fn).toHaveBeenCalledOnce();
    });
    expect(prepare.fn.mock.calls[0]?.[0]).toMatchObject({
      source: "<h1>hi</h1>",
      mediaType: "text/html",
    });
  });

  it("live renders the prepared document in a sandbox with no same-origin", async () => {
    useDrawerStore.getState().setCompiling("t1", "a1");
    draw({ title: "Demo" });
    const frame = await screen.findByTitle("artifact-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toBe("<!doctype html><p>doc</p>");
    expect(screen.getByText("Demo")).not.toBeNull();
  });

  it("a failed prepare shows the reason instead of an empty frame", async () => {
    prepare.fn.mockResolvedValue({
      kind: "failed",
      reason: "jsx did not compile: Unexpected end of input",
    });
    useDrawerStore.getState().setCompiling("t1", "a1");
    draw();
    expect(await screen.findByText(/did not compile/)).not.toBeNull();
    expect(screen.queryByTitle("artifact-frame")).toBeNull();
  });

  it("disabled gate shows the notice instead of the frame", () => {
    useDrawerStore.getState().setNotice("t1", "Stored context line.");
    draw({ engine: { platform: "linux", opaqueProven: false } });
    expect(screen.getByText(/off on Linux/)).not.toBeNull();
    expect(screen.getByText("Stored context line.")).not.toBeNull();
    expect(screen.queryByTitle("artifact-frame")).toBeNull();
    // A disabled gate prepares nothing: no policy is ever requested for an
    // artifact that cannot be rendered.
    expect(prepare.fn).not.toHaveBeenCalled();
  });

  it("no prop can widen the sandbox (D108)", async () => {
    // Even an unknown prop carrying a hostile token changes nothing: the
    // attribute is computed by `sandboxAttr()`, which refuses
    // `allow-same-origin` outright.
    useDrawerStore.getState().setCompiling("t1", "a1");
    const { container } = draw({
      ...({ sandbox: "allow-scripts allow-same-origin" } as Record<string, unknown>),
    });
    await waitFor(() => {
      expect(screen.getByTitle("artifact-frame")).not.toBeNull();
    });
    const frame = screen.getByTitle("artifact-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
  });
});