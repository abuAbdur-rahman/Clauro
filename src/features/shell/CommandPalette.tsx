/**
 * Sectioned command palette (prototype parity, index.html:516-524). Sections
 * render in Actions / Chats / Projects / Settings order with ArrowUp/Down +
 * Enter/Esc keyboard nav. Selecting closes the palette (onClose) after the
 * action runs. Built-in ids dispatch to real stores; thread/project opening
 * beyond the store rides an intent event for the owning task (023/App view),
 * the same convention as App's intent collection.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Command,
  Folder,
  Layers,
  MessageSquare,
  PanelLeft,
  Plug,
  Plus,
  Search,
  SearchX,
  Settings as SettingsIcon,
  SunMoon,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  BUILTIN_ACTION_ITEMS,
  filterPalette,
  groupPalette,
  itemSection,
  paletteActions,
  settingsPageItems,
  type PaletteItem,
  type PaletteSection,
  type PaletteState,
} from "./palette";
import { Kbd, SETTINGS_SECTION_ICONS } from "../settings/SettingsDialog";
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

/** Leading icons mirror the html palette (index.html:517-518): per-action
 *  icons, message-square for chats, folder for projects, the settings page
 *  icon for settings entries. Lucide only, one stroke weight. */
const ACTION_ICONS: Partial<Record<string, LucideIcon>> = {
  "action:new-chat": Plus,
  "action:toggle-theme": SunMoon,
  "action:open-settings": SettingsIcon,
  "action:toggle-sidebar": PanelLeft,
  "action:compact": Layers,
  "action:add-provider": Plug,
};

const SECTION_ICONS: Record<PaletteSection, LucideIcon> = {
  Actions: Command,
  Chats: MessageSquare,
  Projects: Folder,
  Settings: SettingsIcon,
};

function itemIcon(item: PaletteItem): LucideIcon {
  if (item.id.startsWith("settings:")) {
    const page = item.id.slice("settings:".length);
    if (isSettingsSection(page)) return SETTINGS_SECTION_ICONS[page];
    return SettingsIcon;
  }
  const action = ACTION_ICONS[item.id];
  if (action !== undefined) return action;
  return SECTION_ICONS[itemSection(item)];
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
      <DialogContent
        aria-label="command palette"
        className="gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        data-testid="palette"
      >
        <DialogTitle className="sr-only">Palette</DialogTitle>
        {m.blocked ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{m.reason}</p>
        ) : (
          <div>
            <div
              data-testid="palette-search-row"
              className="flex h-12 items-center gap-2.5 border-b border-border px-3.5"
            >
              <Search size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted-foreground" />
              <input
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
                className="h-full w-full bg-transparent text-[15px] placeholder:text-muted-foreground"
              />
            </div>
            <div
              id="palette-list"
              role="listbox"
              aria-label="palette results"
              className="max-h-[50vh] overflow-y-auto p-1.5"
              data-testid="palette-list"
            >
              {groups.map(([section, list]) => (
                <div key={section}>
                  <div className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                    {section}
                  </div>
                  <ul>
                    {list.map((i) => {
                      const selected = i.id === activeId;
                      const Icon = itemIcon(i);
                      return (
                        <li key={i.id}>
                          <button
                            type="button"
                            role="option"
                            id={i.id}
                            aria-selected={selected}
                            data-testid={`palette-item-${i.id}`}
                            className={`flex h-9 w-full items-center gap-2.5 rounded px-2.5 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
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
                            <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                            <span className="min-w-0 truncate">{i.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {visible.length === 0 && (
                <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
                  <SearchX size={20} strokeWidth={1.5} aria-hidden="true" className="text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No results</p>
                </div>
              )}
            </div>
            <div
              data-testid="palette-footer"
              className="flex items-center gap-1.5 border-t border-border px-3.5 py-2 text-xs text-muted-foreground"
            >
              <span aria-hidden="true" className="flex items-center gap-1.5">
                <ArrowUp size={12} strokeWidth={2} aria-hidden="true" />
                <ArrowDown size={12} strokeWidth={2} aria-hidden="true" />
                <span>navigate ·</span>
                <Kbd>Enter</Kbd>
                <span>select ·</span>
                <Kbd>Esc</Kbd>
                <span>close</span>
              </span>
              <span className="sr-only">navigate · Enter select · Esc close</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
