import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const markerVariants = cva("flex items-center gap-2 text-sm", {
  variants: {
    variant: {
      default: "text-muted-foreground",
      separator: "text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Marker({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof markerVariants>): React.JSX.Element {
  return (
    <div
      data-slot="marker"
      data-variant={variant}
      className={cn(markerVariants({ variant }), variant === "separator" && "w-full", className)}
      {...props}
    />
  );
}

function MarkerIcon({ className, ...props }: React.ComponentProps<"span">): React.JSX.Element {
  return (
    <span
      data-slot="marker-icon"
      className={cn("flex shrink-0 items-center justify-center", className)}
      {...props}
    />
  );
}

function MarkerContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div data-slot="marker-content" className={cn("min-w-0 flex-1", className)} {...props} />
  );
}

export { Marker, MarkerIcon, MarkerContent, markerVariants };
