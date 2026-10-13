// Ported from shadcn/ui (MIT): https://github.com/shadcn-ui/ui — new-york v4 registry
// copy, adapted in place (D112/D127, component code only). Provenance: PORTED
// (FEATURES.md); attribution per AGENTS.md §4.

import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">): React.JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // D112 local tweak: stock shadcn dilutes the focus ring to `ring-ring/50`
        // — a 50%-alpha blend that measured 2.2:1 light / 2.3:1 dark against the
        // app background (below WCAG 1.4.11's 3:1). styles.css suppresses the
        // global outline at `textarea[data-slot="textarea"]`, so this ring is the
        // component's whole focus indicator and must carry full --ring opacity
        // (5.8:1 light / 4.6:1 dark; asserted in contrast.test.ts).
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
