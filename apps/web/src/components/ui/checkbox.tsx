import { Checkbox as CheckboxPrimitive, type CheckboxProps } from "react-aria-components/Checkbox";
import { composeRenderProps } from "react-aria-components/composeRenderProps";
import { cn } from "cn";
import { IconCheck } from "@/components/icons/lucide";
import { cx } from "@/lib/primitive";

/**
 * A checkbox and its label (Intent UI, adapted): a square 16px box on the `input` border, filled
 * `primary` with a Lucide check when chosen. The box sits on the label's first line, 12px before it.
 */
export function Checkbox({ className, children, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive
      {...props}
      className={cx(
        "group flex items-start gap-x-3 text-sm text-foreground outline-hidden",
        className,
      )}
    >
      {composeRenderProps(children, (children, { isSelected }) => (
        <>
          <span
            data-slot="indicator"
            className={cn(
              // 2px down: centres the 16px box on the label's 20px first line.
              "mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input bg-background transition-colors duration-150 ease-out",
              "group-hover:border-muted-foreground group-focus-visible:border-ring group-disabled:opacity-50",
              isSelected &&
                "border-primary bg-primary text-primary-foreground group-hover:border-primary",
            )}
          >
            {isSelected && <IconCheck className="size-3" strokeWidth={2} />}
          </span>
          <span className="leading-5">{children}</span>
        </>
      ))}
    </CheckboxPrimitive>
  );
}
