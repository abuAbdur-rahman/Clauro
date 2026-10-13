/** Task 029 slice 3 (B05) — summon/settings hotkeys are Windows Ctrl-only. */
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useSummonHotkey, useSettingsHotkey } from "./hotkey";

afterEach(() => {
  cleanup();
  // Call history only (implementations stay): the status tests below assert
  // exact `invoke` counts, and without this the previous test's call leaks in.
  vi.clearAllMocks();
});

function SummonProbe({ onSummon }: { onSummon: () => void }): null {
  useSummonHotkey(onSummon);
  return null;
}

function SettingsProbe({ onOpen }: { onOpen: () => void }): null {
  useSettingsHotkey(onOpen);
  return null;
}

function key(target: Window, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent("keydown", init));
}

describe("summon hotkey (Ctrl-only)", () => {
  it("fires on Ctrl+K", () => {
    const onSummon = vi.fn();
    render(<SummonProbe onSummon={onSummon} />);
    key(window, { key: "k", ctrlKey: true });
    expect(onSummon).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire on Meta+K", () => {
    const onSummon = vi.fn();
    render(<SummonProbe onSummon={onSummon} />);
    key(window, { key: "k", metaKey: true });
    expect(onSummon).not.toHaveBeenCalled();
  });
});

describe("settings hotkey (Ctrl-only)", () => {
  it("fires on Ctrl+,", () => {
    const onOpen = vi.fn();
    render(<SettingsProbe onOpen={onOpen} />);
    key(window, { key: ",", ctrlKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire on Meta+,", () => {
    const onOpen = vi.fn();
    render(<SettingsProbe onOpen={onOpen} />);
    key(window, { key: ",", metaKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// Task 020 — the host half of the summon hotkey: the shortcut is registered
// globally with the Tauri plugin (the OS consumes the press before it can
// reach the webview), so the same press arrives as a `clauro://summon`
// event, and the registration outcome is reported so a conflict says so
// instead of silently degrading to the in-app listener above.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { summonHotkeyStatus } from "./hotkey";

let captured: { global: boolean } = { global: false };
function StatusProbe(): null {
  captured = useSummonHotkey(() => {});
  return null;
}

describe("global summon status (020)", () => {
  it("reports a registered host hotkey as global", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("Ctrl+K");
    render(<StatusProbe />);
    expect(await vi.waitFor(() => {
      if (!captured.global) throw new Error("still local");
      return true;
    })).toBe(true);
    expect(invoke).toHaveBeenCalledWith("summon_hotkey_status");
  });

  it("keeps the in-app fallback (global: false) when registration failed", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("hotkey already in use");
    render(<StatusProbe />);
    // The load-bearing assertion: the hook must ASK the host — hardcoded
    // `false` would look identical from the outside while lying about why.
    expect(invoke).toHaveBeenCalledWith("summon_hotkey_status");
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
    });
    expect(captured.global).toBe(false);
  });

  it("bridges the host summon event into the same handler", async () => {
    const onSummon = vi.fn();
    render(<SummonProbe onSummon={onSummon} />);
    await vi.waitFor(() => {
      expect(listen).toHaveBeenCalledWith("clauro://summon", expect.any(Function));
    });
    const calls = vi.mocked(listen).mock.calls;
    const call = calls[calls.length - 1];
    const handler = call[1] as (e: unknown) => void;
    handler({});
    expect(onSummon).toHaveBeenCalledTimes(1);
  });
});

describe("summonHotkeyStatus (typed, never throws)", () => {
  it("maps a resolved combo to a registered status", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("Ctrl+K");
    await expect(summonHotkeyStatus()).resolves.toEqual({
      global: true,
      combo: "Ctrl+K",
      reason: null,
    });
  });

  it("maps a rejection to a typed reason instead of throwing", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("hotkey already in use");
    const status = await summonHotkeyStatus();
    expect(status.global).toBe(false);
    expect(status.reason).toContain("hotkey already in use");
  });
});
