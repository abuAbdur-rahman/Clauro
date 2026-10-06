import * as React from "react";

import { cn } from "@/lib/utils";

function Message({
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  align?: "start" | "end";
}): React.JSX.Element {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn("flex w-full gap-2", align === "end" && "flex-row-reverse", className)}
      {...props}
    />
  );
}

function MessageGroup({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="message-group"
      className={cn("flex w-full flex-col gap-1", className)}
      {...props}
    />
  );
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="message-avatar"
      className={cn("flex shrink-0 items-end", className)}
      {...props}
    />
  );
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="message-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-1", className)}
      {...props}
    />
  );
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="message-header"
      className={cn("text-muted-foreground text-xs", className)}
      {...props}
    />
  );
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="message-footer"
      className={cn("flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Message, MessageGroup, MessageAvatar, MessageContent, MessageHeader, MessageFooter };
