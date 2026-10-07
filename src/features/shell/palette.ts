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
