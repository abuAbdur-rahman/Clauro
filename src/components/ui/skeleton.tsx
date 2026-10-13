// Ported from shadcn/ui (MIT): https://github.com/shadcn-ui/ui — new-york v4 registry
// copy, adapted in place (D112/D127, component code only). Provenance: PORTED
// (FEATURES.md); attribution per AGENTS.md §4.

import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-accent animate-pulse rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
