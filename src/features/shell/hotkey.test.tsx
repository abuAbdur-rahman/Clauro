/** Task 029 slice 3 (B05) — summon/settings hotkeys are Windows Ctrl-only. */
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useSummonHotkey, useSettingsHotkey } from "./hotkey";

afterEach(() => {
  cleanup();
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
