import { describe, expect, it, beforeEach } from "vitest";
import {
  useDrawerStore,
  sandboxAttr,
  artifactGate,
  SANDBOX_TOKENS,
} from "./store";

beforeEach(() => {
  useDrawerStore.getState().reset();
});

describe("drawer states (DESIGN.md §2.4)", () => {
  it("starts empty with zero chrome", () => {
    const entry = useDrawerStore.getState().drawers["t1"];
    expect(entry).toBeUndefined();
  });

  it("walks empty → compiling → live, newest version shown", () => {
    const s = useDrawerStore.getState();
    s.setCompiling("t1", "a1");
    expect(useDrawerStore.getState().drawers["t1"]?.state).toBe("compiling");
    s.setLive("t1", "a1", 2);
    const entry = useDrawerStore.getState().drawers["t1"];
    expect(entry?.state).toBe("live");
    expect(entry?.version).toBe(2);
  });

  it("clear returns to empty", () => {
    const s = useDrawerStore.getState();
    s.setLive("t1", "a1", 1);
    s.clear("t1");
    expect(useDrawerStore.getState().drawers["t1"]?.state).toBe("empty");
  });

  it("threads keep separate drawers", () => {
    const s = useDrawerStore.getState();
    s.setLive("t1", "a1", 1);
    expect(useDrawerStore.getState().drawers["t2"]).toBeUndefined();
  });

  it("compiling may carry no artifact id yet (D121)", () => {
    // The producer learns the model asked for an artifact at block start —
    // the id does not exist until the loop generates it downstream.
    useDrawerStore.getState().setCompiling("t1", null);
    const entry = useDrawerStore.getState().drawers["t1"];
    expect(entry?.state).toBe("compiling");
    expect(entry?.artifactId).toBeNull();
  });
});

describe("sandbox tokens (D2)", () => {
  it("is exactly allow-scripts, nothing else", () => {
    expect([...SANDBOX_TOKENS]).toEqual(["allow-scripts"]);
    expect(sandboxAttr()).toBe("allow-scripts");
  });

  it("refuses allow-same-origin", () => {
    expect(() => sandboxAttr(["allow-same-origin"])).toThrow(/opaque origin/);
  });
});

describe("Linux gate (D45)", () => {
  it("renders on Windows and on proven Linux", () => {
    expect(artifactGate({ platform: "windows", opaqueProven: true })).toEqual({
      enabled: true,
      notice: null,
    });
    expect(artifactGate({ platform: "linux", opaqueProven: true })).toEqual({
      enabled: true,
      notice: null,
    });
  });

  it("disables with a naming notice on unproven Linux", () => {
    const verdict = artifactGate({ platform: "linux", opaqueProven: false });
    expect(verdict.enabled).toBe(false);
    expect(verdict.notice).toMatch(/Linux/);
    const s = useDrawerStore.getState();
    s.setNotice("t1", verdict.notice ?? "");
    expect(useDrawerStore.getState().drawers["t1"]?.notice).toContain("Linux");
  });
});
