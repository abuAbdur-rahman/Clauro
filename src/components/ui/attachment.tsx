import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const attachmentVariants = cva("flex items-center gap-3 rounded-lg border p-3", {
  variants: {
    state: {
      idle: "",
      uploading: "",
      processing: "",
      error: "border-destructive/50",
      done: "",
    },
    size: {
      default: "",
      sm: "gap-2 p-2 text-sm",
      xs: "gap-1.5 p-1.5 text-xs",
    },
    orientation: {
      horizontal: "flex-row",
      vertical: "flex-col items-stretch",
    },
  },
  defaultVariants: {
    state: "done",
    size: "default",
    orientation: "horizontal",
  },
});

function Attachment({
  className,
  state,
  size,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof attachmentVariants>): React.JSX.Element {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      data-orientation={orientation}
      className={cn(attachmentVariants({ state, size, orientation }), className)}
      {...props}
    />
  );
}

function AttachmentMedia({
  variant = "icon",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "icon" | "image";
}): React.JSX.Element {
  return (
    <div
      data-slot="attachment-media"
      data-variant={variant}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md",
        variant === "icon" && "bg-muted size-9",
        variant === "image" && "size-16",
        className,
      )}
      {...props}
    />
  );
}

function AttachmentContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="attachment-content"
      className={cn("flex min-w-0 flex-1 flex-col", className)}
      {...props}
    />
  );
}

function AttachmentTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="attachment-title"
      className={cn(
        "truncate text-sm font-medium",
        "in-data-[state=uploading]:animate-pulse in-data-[state=processing]:animate-pulse",
        className,
      )}
      {...props}
    />
  );
}

function AttachmentDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="attachment-description"
      className={cn("text-muted-foreground truncate text-xs", className)}
      {...props}
    />
  );
}

function AttachmentActions({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="attachment-actions"
      className={cn("flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  );
}

function AttachmentAction({
  size = "icon",
  ...props
}: React.ComponentProps<typeof Button>): React.JSX.Element {
  return <Button data-slot="attachment-action" size={size} variant="ghost" {...props} />;
}

function AttachmentTrigger({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }): React.JSX.Element {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="attachment-trigger"
      className={cn(!asChild && "absolute inset-0 rounded-lg", className)}
      {...props}
    />
  );
}

function AttachmentGroup({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="attachment-group"
      className={cn("flex snap-x gap-2 overflow-x-auto pb-1", className)}
      {...props}
    />
  );
}

export {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
  AttachmentGroup,
  attachmentVariants,
};
