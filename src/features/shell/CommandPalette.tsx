import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  paletteActions,
  filterPalette,
  type PaletteState,
  type PaletteItem,
  type PaletteTab,
} from "./palette";

const TABS: PaletteTab[] = ["all", "chats", "projects", "actions"];

export function CommandPalette({
  state,
  open,
  recents = [],
  onAction = () => {},
}: {
  state: PaletteState;
  open: boolean;
  recents?: readonly PaletteItem[];
  onAction?: (id: string) => void;
}) {
  const m = paletteActions(state);
  const [tab, setTab] = useState<PaletteTab>("all");
  const [q, setQ] = useState("");
  const actionItems: PaletteItem[] = m.available.map((a) => ({
    id: `action:${a}`,
    tab: "actions",
    label: a,
  }));
  const visible = filterPalette([...recents, ...actionItems], tab, q);
  return (
    <Dialog open={open}>
      <DialogContent aria-label="command palette" className="sm:max-w-lg">
        <DialogTitle>Palette</DialogTitle>
        {m.blocked ? (
          <p>{m.reason}</p>
        ) : (
          <div>
            <Input
              aria-label="Search palette"
              placeholder="Search actions, chats, projects…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
              }}
            />
            <div role="tablist" aria-label="palette sections" className="mt-2 flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? "font-semibold underline" : "text-neutral-400"}
                  onClick={() => {
                    setTab(t);
                  }}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <ul className="mt-2 max-h-64 overflow-y-auto">
              {visible.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onAction(i.id);
                    }}
                  >
                    {i.label}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-neutral-500">Close Esc · Filter by typing</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
