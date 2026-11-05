"use client";

import { Separator as Divider, type SeparatorProps } from "react-aria-components/Separator";
import { cn } from "cn";

/** A hairline rule. With a `label` ("or"), the label sits in a gap in the middle of the line. */
export function Separator({
  orientation = "horizontal",
  className,
  label,
  ...props
}: SeparatorProps & { label?: string }) {
  if (label) {
    return (
      <div
        role="separator"
        aria-orientation="horizontal"
        className={cn("flex items-center gap-3 text-xs text-muted-foreground", className)}
      >
        <span className="h-px flex-1 bg-border forced-colors:bg-[ButtonBorder]" />
        {label}
        <span className="h-px flex-1 bg-border forced-colors:bg-[ButtonBorder]" />
      </div>
    );
  }
  return (
    <Divider
      orientation={orientation}
      className={cn(
        "shrink-0 border-0 bg-border forced-colors:bg-[ButtonBorder]",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
