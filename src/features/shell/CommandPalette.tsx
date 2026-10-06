import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { paletteActions, type PaletteState } from "./palette";

export function CommandPalette({ state, open }: { state: PaletteState; open: boolean }) {
  const m = paletteActions(state);
  return (
    <Dialog open={open}>
      <DialogContent aria-label="command palette">
        <DialogTitle>Palette</DialogTitle>
        {m.blocked ? (
          <p>{m.reason}</p>
        ) : (
          <ul>
            {m.available.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
