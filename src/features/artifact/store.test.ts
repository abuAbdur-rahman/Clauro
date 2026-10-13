import { describe, expect, it, beforeEach } from "vitest";
import {
  useDrawerStore,
  sandboxAttr,
  artifactGate,
  detectEngineGate,
  recordOpaqueOriginProbe,
  SANDBOX_TOKENS,
  DRAWER_MAX_THREADS,
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

  it("refuses any token outside the fixed sandbox — no widening at all (D108)", () => {
    // The refusal list used to be one token: `allow-popups` or
    // `allow-top-navigation` would have been appended verbatim.
    for (const token of ["allow-popups", "allow-forms", "allow-modals", "allow-top-navigation"]) {
      expect(() => sandboxAttr([token]), token).toThrow(/allowlist|fixed sandbox/i);
    }
    expect(sandboxAttr()).toBe("allow-scripts");
    expect(sandboxAttr([])).toBe("allow-scripts");
  });
});

describe("drawer store bound (audit 14, IMPORTANT: never-evicted maps)", () => {
  it("evicts the oldest thread beyond its bound", () => {
    const s = useDrawerStore.getState();
    for (let i = 0; i < DRAWER_MAX_THREADS + 4; i += 1) {
      s.setLive(`t${String(i)}`, `a${String(i)}`, 1);
    }
    const drawers = useDrawerStore.getState().drawers;
    expect(Object.keys(drawers).length).toBeLessThanOrEqual(DRAWER_MAX_THREADS);
    expect(drawers["t0"]).toBeUndefined();
    expect(drawers[`t${String(DRAWER_MAX_THREADS + 3)}`]).toBeDefined();
  });

  it("keeps a touched thread instead of evicting it", () => {
    const s = useDrawerStore.getState();
    for (let i = 0; i < DRAWER_MAX_THREADS; i += 1) {
      s.setLive(`t${String(i)}`, `a${String(i)}`, 1);
    }
    // Re-setting a key must refresh its recency, or the store is FIFO and a
    // thread the user is actively looking at is the first thing evicted.
    useDrawerStore.getState().setLive("t0", "a0", 2);
    useDrawerStore.getState().setLive("extra", "aX", 1);
    const drawers = useDrawerStore.getState().drawers;
    expect(drawers["t0"]).toBeDefined();
    expect(drawers["extra"]).toBeDefined();
    expect(drawers["t1"]).toBeUndefined();
  });
});

describe("engine gate derived from this runtime (D45, D132)", () => {
  beforeEach(() => {
    recordOpaqueOriginProbe(false);
  });

  it("reports Windows or other, and starts unproven", () => {
    const gate = detectEngineGate();
    // D132: only the platform we ship names itself; everything else is `other`.
    expect(["windows", "other"]).toContain(gate.platform);
    // No 021 probe result exists yet, so nothing is proven.
    expect(gate.opaqueProven).toBe(false);
  });

  it("reads back the 021 probe verdict", () => {
    recordOpaqueOriginProbe(true);
    expect(detectEngineGate().opaqueProven).toBe(true);
    recordOpaqueOriginProbe(false);
    expect(detectEngineGate().opaqueProven).toBe(false);
  });
});

describe("gate verdict on the shipped platform (D132)", () => {
  it("renders, unconditionally — the disable branch D45 carried was Linux-only", () => {
    // The runtime disable existed to keep an *unproven WebKitGTK engine* from
    // rendering artifacts; D132 removed that engine, so there is nothing left
    // for it to fail closed on. The Windows obligation is the release proof
    // (SPEC.md A8), not a runtime switch.
    expect(artifactGate()).toEqual({ enabled: true, notice: null });
  });
});
