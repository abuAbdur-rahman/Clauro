/**
 * Sectioned command palette (prototype parity, index.html:516-524). Sections
 * render in Actions / Chats / Projects / Settings order with ArrowUp/Down +
 * Enter/Esc keyboard nav. Selecting closes the palette (onClose) after the
 * action runs. Built-in ids dispatch to real stores; thread/project opening
 * beyond the store rides an intent event for the owning task (023/App view),
 * the same convention as App's intent collection.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  BUILTIN_ACTION_ITEMS,
  filterPalette,
  groupPalette,
  paletteActions,
  settingsPageItems,
  type PaletteItem,
  type PaletteState,
} from "./palette";
import { useSettingsStore, type SettingsSection } from "./settings";
import { useThreadStore } from "../catalogue/thread";
import { useTheme } from "./usetheme";

export interface PaletteChat {
  id: string;
  title: string;
}

export interface PaletteProject {
  id: string;
  name: string;
}

const SETTING_IDS: readonly string[] = [
  "general",
  "appearance",
  "providers",
  "models",
  "memory",
  "data",
  "shortcuts",
  "about",
];

function isSettingsSection(value: string): value is SettingsSection {
  return SETTING_IDS.includes(value);
}

export function CommandPalette({
  state,
  open,
  recents = [],
  chats = [],
  projects = [],
  onAction = () => {},
  onClose = () => {},
}: {
  state: PaletteState;
  open: boolean;
  recents?: readonly PaletteItem[];
  chats?: readonly PaletteChat[];
  projects?: readonly PaletteProject[];
  onAction?: (id: string) => void;
  onClose?: () => void;
}) {
  const m = paletteActions(state);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const { mode, setMode } = useTheme();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const chatItems: PaletteItem[] = chats.map((c) => ({
      id: `chat:${c.id}`,
      tab: "chats",
      label: c.title,
      section: "Chats",
    }));
    const projectItems: PaletteItem[] = projects.map((p) => ({
      id: `project:${p.id}`,
      tab: "projects",
      label: p.name,
      section: "Projects",
    }));
    return [
      ...BUILTIN_ACTION_ITEMS,
      ...recents,
      ...chatItems,
      ...projectItems,
      ...settingsPageItems(),
    ];
  }, [recents, chats, projects]);

  const visible = useMemo(() => filterPalette(items, "all", q), [items, q]);
  const groups = useMemo(() => groupPalette(visible), [visible]);
  const safeIdx = visible.length === 0 ? 0 : Math.min(idx, visible.length - 1);
  const activeId = visible.length === 0 ? undefined : visible[safeIdx].id;

  // Fresh query + selection on every open; focus the input for typing.
  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => {
        window.clearTimeout(t);
      };
    }
  }, [open ]);

  function runBuiltin(id: string): void {
    if (id === "action:new-chat") {
      useThreadStore.getState().openThread(`thread-${String(Date.now())}`);
    } else if (id === "action:toggle-theme") {
      setMode(mode === "dark" ? "light" : "dark");
    } else if (id === "action:open-settings") {
      openSettings();
    } else if (id === "action:add-provider") {
      openSettings("providers");
    } else if (id === "action:toggle-sidebar") {
      // Unified with the vendored sidebar's own Ctrl+B listener (B05):
      // one synthetic keypress, no second toggle implementation.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }));
    } else if (id === "action:compact") {
      // Intent only — compaction dispatch belongs to the turn loop (023).
      window.dispatchEvent(new CustomEvent("clauro:compact-request"));
    } else if (id.startsWith("chat:")) {
      useThreadStore.getState().openThread(id.slice("chat:".length));
    } else if (id.startsWith("project:")) {
      // Intent only — view switching belongs to the App shell owner.
      window.dispatchEvent(
        new CustomEvent("clauro:open-project", { detail: { id: id.slice("project:".length) } }),
      );
    } else if (id.startsWith("settings:")) {
      const page = id.slice("settings:".length);
      if (isSettingsSection(page)) openSettings(page);
    }
  }

  function select(id: string): void {
    runBuiltin(id);
    onAction(id);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent aria-label="command palette" className="sm:max-w-lg" data-testid="palette">
        <DialogTitle>Palette</DialogTitle>
        {m.blocked ? (
          <p>{m.reason}</p>
        ) : (
          <div>
            <Input
              ref={inputRef}
              aria-label="Search palette"
              aria-activedescendant={activeId}
              aria-controls="palette-list"
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              placeholder="Search chats, projects, settings, actions…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setIdx((i) => Math.min(i + 1, Math.max(0, visible.length - 1)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIdx((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (visible.length > 0) select(visible[safeIdx].id);
                }
              }}
            />
            <div
              id="palette-list"
              role="listbox"
              aria-label="palette results"
              className="mt-2 max-h-64 overflow-y-auto"
              data-testid="palette-list"
            >
              {groups.map(([section, list]) => (
                <div key={section}>
                  <div className="px-2 pt-2 text-xs font-medium text-neutral-500">{section}</div>
                  <ul>
                    {list.map((i) => {
                      const selected = i.id === activeId;
                      return (
                        <li key={i.id}>
                          <button
                            type="button"
                            role="option"
                            id={i.id}
                            aria-selected={selected}
                            data-testid={`palette-item-${i.id}`}
                            className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
                              selected ? "bg-accent" : ""
                            }`}
                            onMouseEnter={() => {
                              const at = visible.findIndex((v) => v.id === i.id);
                              if (at >= 0) setIdx(at);
                            }}
                            onClick={() => {
                              select(i.id);
                            }}
                          >
                            {i.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {visible.length === 0 && <p className="px-2 py-4 text-sm text-neutral-500">No results</p>}
            </div>
            <p className="mt-2 text-xs text-neutral-500">↑↓ navigate · Enter select · Esc close</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
