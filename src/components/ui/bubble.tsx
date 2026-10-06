import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const bubbleVariants = cva("w-fit max-w-[80%] rounded-lg px-3 py-2 text-sm", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground",
      secondary: "bg-secondary text-secondary-foreground",
      muted: "bg-muted text-muted-foreground",
      tinted: "bg-primary/10 text-primary",
      outline: "border bg-background",
      ghost: "max-w-full rounded-none bg-transparent px-0",
      destructive: "bg-destructive text-white",
    },
    align: {
      start: "self-start",
      end: "self-end",
    },
  },
  defaultVariants: {
    variant: "default",
    align: "start",
  },
});

function Bubble({
  className,
  variant,
  align,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof bubbleVariants>): React.JSX.Element {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant, align }), "flex flex-col", className)}
      {...props}
    />
  );
}

function BubbleContent({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }): React.JSX.Element {
  const Comp = asChild ? Slot : "div";
  return <Comp data-slot="bubble-content" className={cn("min-w-0", className)} {...props} />;
}

function BubbleReactions({
  side = "bottom",
  align = "end",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "top" | "bottom";
  align?: "start" | "end";
}): React.JSX.Element {
  return (
    <div
      data-slot="bubble-reactions"
      data-side={side}
      data-align={align}
      className={cn("flex items-center gap-1 pt-1", align === "end" && "justify-end", className)}
      {...props}
    />
  );
}

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="bubble-group"
      className={cn("flex w-full flex-col gap-1", className)}
      {...props}
    />
  );
}

export { Bubble, BubbleContent, BubbleReactions, BubbleGroup, bubbleVariants };
