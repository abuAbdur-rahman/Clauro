export interface PaletteState {
  turnRunning: boolean;
}

export interface PaletteModel {
  blocked: boolean;
  reason: string | null;
  available: string[];
}

const BASE = ["/compact", "new-thread", "toggle-theme", "open-settings"];

export type PaletteTab = "all" | "chats" | "projects" | "actions";

export interface PaletteItem {
  id: string;
  tab: Exclude<PaletteTab, "all">;
  label: string;
  /** Grouping section for the sectioned palette (UI-GUIDE parity). Optional
   *  so existing callers constructing {id, tab, label} keep compiling. */
  section?: PaletteSection;
}

/** Section order mirrors the prototype palette (index.html:516-524). */
export type PaletteSection = "Actions" | "Chats" | "Projects" | "Settings";

export const PALETTE_SECTIONS: readonly PaletteSection[] = [
  "Actions",
  "Chats",
  "Projects",
  "Settings",
];

/** Built-in action entries. Ids are stable contract: the palette component
 *  dispatches them to real stores; owners (023 turn, App view) own the rest. */
export const BUILTIN_ACTION_ITEMS: readonly PaletteItem[] = [
  { id: "action:new-chat", tab: "actions", label: "New chat", section: "Actions" },
  { id: "action:toggle-theme", tab: "actions", label: "Toggle theme", section: "Actions" },
  { id: "action:open-settings", tab: "actions", label: "Open Settings", section: "Actions" },
  { id: "action:toggle-sidebar", tab: "actions", label: "Toggle sidebar", section: "Actions" },
  { id: "action:compact", tab: "actions", label: "Compact conversation", section: "Actions" },
  { id: "action:add-provider", tab: "actions", label: "Add provider", section: "Actions" },
];

/** Settings pages reachable from the palette. Local copy — the real shell
 *  must never import `@/mock/seed` (shell.mockmode.test.ts); labels mirror
 *  the prototype PAGES verbatim. */
export const PALETTE_SETTINGS_PAGES: readonly { id: string; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "memory", label: "Memory" },
  { id: "data", label: "Data" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "about", label: "About" },
];

export function settingsPageItems(): PaletteItem[] {
  return PALETTE_SETTINGS_PAGES.map((p) => ({
    id: `settings:${p.id}`,
    tab: "actions",
    label: p.label,
    section: "Settings",
  }));
}

/** Section of one item: explicit section wins, otherwise derived from tab. */
export function itemSection(item: PaletteItem): PaletteSection {
  if (item.section !== undefined) return item.section;
  switch (item.tab) {
    case "chats":
      return "Chats";
    case "projects":
      return "Projects";
    default:
      return "Actions";
  }
}

/** Group items into ordered non-empty sections for rendering. */
export function groupPalette(items: readonly PaletteItem[]): Array<[PaletteSection, PaletteItem[]]> {
  const out = PALETTE_SECTIONS.map(
    (section): [PaletteSection, PaletteItem[]] => [
      section,
      items.filter((i) => itemSection(i) === section),
    ],
  );
  return out.filter(([, list]) => list.length > 0);
}

/** Filter recents by tab + query, our own labels (D39). */
export function filterPalette(
  items: readonly PaletteItem[],
  tab: PaletteTab,
  query: string,
): PaletteItem[] {
  const q = query.trim().toLowerCase();
  return items.filter(
    (i) =>
      (tab === "all" || i.tab === tab) &&
      (q === "" || i.label.toLowerCase().includes(q)),
  );
}
/** Palette blocked with reason while turn runs (020). Bash approval and
 *  attach never live here (D66, D44). */
export function paletteActions(st: PaletteState): PaletteModel {
  if (st.turnRunning) {
    return {
      blocked: true,
      reason: "Turn running — palette actions resume when idle",
      available: [],
    };
  }
  return { blocked: false, reason: null, available: [...BASE] };
}
