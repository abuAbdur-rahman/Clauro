// Ported from shadcn/ui (MIT): https://github.com/shadcn-ui/ui — new-york v4 registry
// copy, adapted in place (D112/D127, component code only). Provenance: PORTED
// (FEATURES.md); attribution per AGENTS.md §4.

import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">): React.JSX.Element {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // D112 local tweak: drop the stock `selection:bg-primary
        // selection:text-primary-foreground`. The unlayered ::selection rule in
        // styles.css beats the layered utility for background (light: a 32%
        // tint, not the solid accent), while `selection:text-primary-foreground`
        // still lands — near-white on the light tint ≈1.4:1. Removing both
        // leaves the global rule's inherited foreground on the tint (≥4.5:1,
        // asserted in contrast.test.ts).
        "file:text-foreground placeholder:text-muted-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
