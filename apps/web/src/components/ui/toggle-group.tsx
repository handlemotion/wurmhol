import { composeRenderProps } from "react-aria-components/composeRenderProps";
import { ToggleButton, type ToggleButtonProps } from "react-aria-components/ToggleButton";
import {
  ToggleButtonGroup,
  type ToggleButtonGroupProps,
} from "react-aria-components/ToggleButtonGroup";
import { tv } from "tailwind-variants";
import { cx } from "@/lib/primitive";

/**
 * A segmented choice of one (Intent UI, adapted): items share one bordered strip, 2px inside it,
 * and the chosen one takes the `accent` fill. Items are 28px tall, the height of an `md` control
 * minus the strip's border and gutter.
 */
export function ToggleGroup({ className, ...props }: ToggleButtonGroupProps) {
  return (
    <ToggleButtonGroup
      data-slot="control"
      selectionMode="single"
      disallowEmptySelection
      {...props}
      className={cx("inline-flex gap-0.5 border border-input bg-background p-0.5", className)}
    />
  );
}

const itemStyles = tv({
  base: [
    "inline-flex h-7 flex-1 items-center justify-center whitespace-nowrap px-3 text-sm text-muted-foreground tabular-nums outline-hidden",
    "transition-colors duration-150 ease-out hover:text-foreground",
  ],
  variants: {
    isSelected: { true: "bg-accent text-accent-foreground" },
    isFocusVisible: { true: "ring-1 ring-ring" },
    isDisabled: { true: "opacity-50" },
  },
});

export function ToggleGroupItem({ className, ...props }: ToggleButtonProps) {
  return (
    <ToggleButton
      {...props}
      className={composeRenderProps(className, (className, renderProps) =>
        itemStyles({ ...renderProps, className }),
      )}
    />
  );
}
