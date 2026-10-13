// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { ArtifactDrawer } from "./ArtifactDrawer";
import { useDrawerStore } from "../features/artifact/store";
import type { prepareArtifact, PrepareResult } from "../features/artifact/prepare";
import type { HostSide, HostSideOptions } from "../features/artifact/channel";

/**
 * The drawer is where a compiled artifact becomes visible, so its contract is
 * narrow and worth stating: no blank frame, ever. Every failure has to show a
 * reason, and the sandbox tokens are host-fixed (D108) with no prop that could
 * widen them.
 */

type PrepareArgs = Parameters<typeof prepareArtifact>[0];

const prepare = vi.hoisted(() => {
  const url = "http://artifact.localhost/__clauro/doc/n1";
  return {
    url,
    fn: vi.fn<(args: PrepareArgs) => Promise<PrepareResult>>(() =>
      Promise.resolve({ kind: "live", url, nonce: "n1" }),
    ),
  };
});

vi.mock("../features/artifact/prepare", () => ({
  prepareArtifact: prepare.fn,
  newNonce: () => "n1",
}));

const host = vi.hoisted(() => ({
  hostSide: vi.fn<(options: HostSideOptions) => HostSide>(() => ({ dispose: vi.fn() })),
}));

vi.mock("../features/artifact/channel", () => ({
  hostSide: host.hostSide,
}));

beforeEach(() => {
  cleanup();
  prepare.fn.mockClear();
  prepare.fn.mockResolvedValue({ kind: "live", url: prepare.url, nonce: "n1" });
  host.hostSide.mockClear();
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
    // D123: the frame navigates to the host's URL; the bytes are Rust's to
    // serve, so there is no inline document left to assert on.
    expect(frame.getAttribute("src")).toBe(prepare.url);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(screen.getByText("Demo")).not.toBeNull();
  });

  it("hands the publisher seam through to prepare (D123)", async () => {
    // The drawer owns the seam like `fetchPolicy`: production calls
    // `artifact_publish` through the default, and a caller that injects one
    // must reach prepare untouched.
    const publishDoc = vi.fn(() => Promise.resolve("http://artifact.localhost/__clauro/doc/x"));
    useDrawerStore.getState().setCompiling("t1", "a1");
    draw({ title: "Demo", publishDoc });
    await waitFor(() => {
      expect(prepare.fn).toHaveBeenCalledOnce();
    });
    expect(prepare.fn.mock.calls[0]?.[0]).toMatchObject({ publishDoc });
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

  it("a switched artifact never presents the previous artifact's frame", async () => {
    // Review 32 NIT: `result` outlived `artifactId`, so switching artifacts
    // flashed the OLD artifact's document (or its failure) until the new
    // prepare resolved. Compiling must cover that window.
    useDrawerStore.getState().setCompiling("t1", "a1");
    draw();
    await screen.findByTitle("artifact-frame");
    act(() => {
      useDrawerStore.getState().setCompiling("t1", "a2");
    });
    // Synchronously after the switch, before a2's prepare can resolve.
    expect(screen.queryByTitle("artifact-frame")).toBeNull();
    expect(screen.getByText(/compiling/i)).not.toBeNull();
    // And the new artifact still prepares and lands.
    await waitFor(() => {
      expect(prepare.fn).toHaveBeenCalledTimes(2);
    });
    await screen.findByTitle("artifact-frame");
  });

  it("has no disabled state left to show (D132)", () => {
    // D45's runtime disable was Linux-only ("an unproven WebKitGTK engine
    // renders nothing"), and D132 took that engine out of v1. The drawer still
    // consults the gate, but nothing can close it: guarding the unreachable
    // branch here keeps it from being re-armed by accident.
    useDrawerStore.getState().setNotice("t1", "Stored context line.");
    draw({ engine: { platform: "windows", opaqueProven: false } });
    expect(screen.queryByText(/off on Linux/)).toBeNull();
    expect(screen.queryByLabelText("artifact drawer disabled")).toBeNull();
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

  it("a live entry prepares and renders without passing through compiling (D121)", async () => {
    // The production producer's turn-done path lands straight in `live`: the
    // row exists, so the drawer must prepare it. Gating prepare on the
    // `compiling` state alone would spin forever on this path.
    useDrawerStore.getState().setLive("t1", "a9", 2);
    draw({ title: "Demo" });
    await waitFor(() => {
      expect(prepare.fn).toHaveBeenCalledOnce();
    });
    expect(prepare.fn.mock.calls[0]?.[0]).toMatchObject({
      source: "<h1>hi</h1>",
      mediaType: "text/html",
    });
    const frame = await screen.findByTitle("artifact-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.getByText("Demo")).not.toBeNull();
    expect(screen.getByText("v2")).not.toBeNull();
  });

  it("attaches the channel host half to the live frame (D6, D122)", async () => {
    // The handshake's host side exists for a caller, and this is it: attach
    // when a live frame is on screen, report readiness when the frame has
    // claimed its port, and take a runtime error report as a STATUS LINE —
    // never as a shell failure (review 14 NIT): the frame stays up so the
    // user can keep looking at the artifact that just complained, and a
    // frame-supplied string is attributed to the frame, in muted styling,
    // instead of tearing the frame down and rendering the string as the
    // drawer's own failure text.
    useDrawerStore.getState().setLive("t1", "a9", 2);
    const { unmount } = draw({ title: "Demo" });
    const frame = await screen.findByTitle<HTMLIFrameElement>("artifact-frame");
    expect(frame.getAttribute("data-artifact-channel")).toBe("pending");
    await waitFor(() => {
      expect(host.hostSide).toHaveBeenCalledOnce();
    });
    const options = host.hostSide.mock.calls[0]?.[0];
    expect(options.frameWindow).toBe(frame.contentWindow);
    act(() => {
      options.onReady?.();
    });
    expect(frame.getAttribute("data-artifact-channel")).toBe("ready");
    // The frame's own runtime reports its errors down the port; a silence
    // there is the blank-frame bug again. The report is visible — as the
    // frame's report, beside the still-live frame.
    act(() => {
      options.onLog({ level: "error", text: "artifact threw at runtime" });
    });
    const report = await screen.findByTestId("artifact-frame-report");
    expect(report.textContent).toContain("artifact threw at runtime");
    expect(report.className).toContain("text-muted-foreground");
    expect(report.className).not.toContain("text-destructive");
    expect(screen.getByTitle("artifact-frame")).not.toBeNull();
    expect(screen.queryByText("Compiling…")).toBeNull();
    // The host half is disposed the moment its frame goes away — here only
    // by unmount: an error report never tears the frame down.
    unmount();
    const disposal = host.hostSide.mock.results[0].value as HostSide;
    expect(disposal.dispose).toHaveBeenCalledOnce();
  });
});
