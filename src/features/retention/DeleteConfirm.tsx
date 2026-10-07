import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function DeleteConfirm({
  target,
  onConfirm,
}: {
  target: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog open>
      <DialogContent aria-label={`delete ${target}`}>
        <DialogTitle>Delete {target}?</DialogTitle>
        <p>
          This will permanently destroy {target}. Deleting a chat does not delete what memory
          learned from it.
        </p>
        <button onClick={onConfirm}>Delete</button>
      </DialogContent>
    </Dialog>
  );
}
