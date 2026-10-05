// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ArtifactDrawer } from "./ArtifactDrawer";
import { useDrawerStore } from "./artifact";

beforeEach(() => {
  cleanup();
  useDrawerStore.getState().reset();
});

const ENGINE = { platform: "windows" as const, opaqueProven: true };

describe("ArtifactDrawer (DESIGN.md §2.4)", () => {
  it("empty renders a zero-width, chromeless column", () => {
    const { container } = render(
      <ArtifactDrawer threadId="t1" engine={ENGINE} sourceHtml="" title="" />
    );
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.getAttribute("aria-hidden")).toBe("true");
    expect(aside?.className).toMatch(/w-0/);
    expect(screen.queryByText(/compiling/i)).toBeNull();
  });

  it("compiling says compiling", () => {
    useDrawerStore.getState().setCompiling("t1", "a1");
    render(<ArtifactDrawer threadId="t1" engine={ENGINE} sourceHtml="" title="D" />);
    expect(screen.getByText(/compiling/i)).not.toBeNull();
    expect(screen.queryByTitle("artifact-frame")).toBeNull();
  });

  it("live renders the frame with sandbox tokens and no same-origin", () => {
    useDrawerStore.getState().setLive("t1", "a1", 2);
    render(
      <ArtifactDrawer threadId="t1" engine={ENGINE} sourceHtml="<h1>hi</h1>" title="Demo" />
    );
    const frame = screen.getByTitle("artifact-frame");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(screen.getByText("Demo")).not.toBeNull();
  });

  it("disabled gate shows the notice instead of the frame", () => {
    useDrawerStore.getState().setNotice("t1", "Stored context line.");
    render(
      <ArtifactDrawer
        threadId="t1"
        engine={{ platform: "linux", opaqueProven: false }}
        sourceHtml="<h1>hi</h1>"
        title="Demo"
      />
    );
    expect(screen.getByText(/off on Linux/)).not.toBeNull();
    expect(screen.getByText("Stored context line.")).not.toBeNull();
    expect(screen.queryByTitle("artifact-frame")).toBeNull();
  });
});
