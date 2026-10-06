export interface PaletteState {
  turnRunning: boolean;
}

export interface PaletteModel {
  blocked: boolean;
  reason: string | null;
  available: string[];
}

const BASE = ["/compact", "new-thread", "toggle-theme", "open-settings"];

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
