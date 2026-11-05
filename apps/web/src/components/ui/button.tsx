import {
  Button as ButtonPrimitive,
  type ButtonProps as ButtonPrimitiveProps,
} from "react-aria-components/Button";
import { tv, type VariantProps } from "tailwind-variants";
import { Children, isValidElement } from "react";
import { cx } from "@/lib/primitive";
import { Loader } from "./loader";

/**
 * React Aria's Button, for press, pending and the triggers that wrap it (MenuTrigger,
 * DialogTrigger), styled from tokens. Hover is React Aria's `data-hovered` (see styles.css), and
 * the fill, edge, label and icon all change on one 150ms ease-out, so they move together.
 */
export const buttonStyles = tv({
  base: [
    "inline-flex items-center justify-center border",
    "transition-[scale,background-color,border-color,color] duration-150 ease-out",
    "*:[svg]:shrink-0 *:[svg]:transition-colors *:[svg]:duration-150 *:[svg]:ease-out",
    // Tactile press (DESIGN.md): a short squeeze on native `:active`, which never waits on a
    // React render. Not on menu triggers (a squeezed trigger looks narrower than its menu), when
    // disabled or pending, or under reduced motion.
    "motion-safe:[&:active]:not-aria-[haspopup]:scale-97 disabled:[&:active]:scale-100 pending:[&:active]:scale-100",
    "outline-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "disabled:opacity-50 pending:opacity-50",
  ],
  variants: {
    // Flat, with an edge a step darker than the fill: depth doesn't sit well on sharp corners.
    intent: {
      primary: [
        "border-primary-button-border bg-primary-button text-primary-foreground",
        "hover:bg-primary-button-hover pressed:bg-primary-button-hover",
        "*:[svg]:text-primary-foreground/60 hover:*:[svg]:text-primary-foreground/80 pressed:*:[svg]:text-primary-foreground/80",
      ],
      secondary: [
        "border-secondary-border bg-secondary text-secondary-foreground",
        "hover:bg-secondary-hover pressed:bg-secondary-hover",
        "*:[svg]:text-muted-foreground hover:*:[svg]:text-secondary-foreground pressed:*:[svg]:text-secondary-foreground",
      ],
      outline: [
        "border-border bg-background text-foreground",
        "hover:bg-outline-hover pressed:bg-outline-hover",
        "*:[svg]:text-muted-foreground hover:*:[svg]:text-foreground pressed:*:[svg]:text-foreground",
      ],
      // No fill and no edge: only the icon answers the pointer.
      plain: [
        "border-0 bg-transparent text-foreground",
        "*:[svg]:text-muted-foreground hover:*:[svg]:text-foreground pressed:*:[svg]:text-foreground",
      ],
      danger: [
        "border-danger-border bg-danger text-danger-foreground *:[svg]:text-danger-foreground",
        "hover:bg-danger-hover pressed:bg-danger-hover",
      ],
    },
    // Icons grow with the button, so a glyph's ink balances the 13px label beside it.
    size: {
      xs: "h-7 gap-x-2.5 px-2 text-sm *:[svg]:size-3.5 *:data-[slot=loader]:size-3.5",
      sm: [
        "min-h-9 gap-x-1.5 px-3 py-[calc(--spacing(2)-1px)] sm:min-h-8 sm:px-[calc(--spacing(3)-1px)] sm:py-[calc(--spacing(1.5)-1px)] sm:text-sm/5",
        "*:[svg]:size-4.5 *:data-[slot=loader]:size-4.5 sm:*:[svg]:size-4 sm:*:data-[slot=loader]:size-4",
      ],
      md: "h-8 gap-x-2.5 px-2 text-sm *:[svg]:size-4 *:data-[slot=loader]:size-4",
      lg: "h-9 gap-x-2.5 px-2.5 text-sm *:[svg]:size-4.25 *:data-[slot=loader]:size-4.25",
      // Square icon buttons. The box is the hit area: nothing reaches past it.
      "sq-xs": "size-6.5 shrink-0 *:[svg]:size-icon *:data-[slot=loader]:size-icon",
      "sq-sm":
        "size-10 shrink-0 sm:size-8 *:[svg]:size-4.5 sm:*:[svg]:size-4 *:data-[slot=loader]:size-4",
      // An action tucked inside a field, e.g. the submit arrow at the end of an input.
      inset: "size-4.5 shrink-0 border-0",
    },
  },
  defaultVariants: { intent: "primary", size: "md" },
});

export interface ButtonProps extends ButtonPrimitiveProps, VariantProps<typeof buttonStyles> {
  ref?: React.Ref<HTMLButtonElement>;
}

export function Button({ className, intent, size, ref, children, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      ref={ref}
      data-inset={size === "inset" || undefined}
      {...props}
      className={cx(buttonStyles({ intent, size }), className)}
    >
      {(values) => {
        const content = typeof children === "function" ? children(values) : children;
        return values.isPending ? <Pending>{content}</Pending> : content;
      }}
    </ButtonPrimitive>
  );
}

/**
 * Loading: the button dims like a disabled one (`pending:opacity-50`). The first icon is swapped
 * for a spinner in the same place; a button with no icon shimmers its text instead.
 */
function Pending({ children }: { children: React.ReactNode }) {
  const items = Children.toArray(children);
  const icon = items.findIndex((item) => isValidElement(item));
  if (icon === -1) return <span className="shimmer">{children}</span>;
  return items.map((item, i) =>
    i === icon ? <Loader key="loader" className="size-icon" /> : item,
  );
}
