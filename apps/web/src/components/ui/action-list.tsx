import {
  Menu as MenuPrimitive,
  MenuItem as MenuItemPrimitive,
  type MenuItemProps,
  type MenuProps,
} from "react-aria-components/Menu";
import { useMagneticHover } from "@/hooks/use-magnetic-hover";
import { cx } from "@/lib/primitive";
import { FluidHoverHighlight } from "./fluid-hover-highlight";

const ITEM_SELECTOR = "[role='menuitem']";

/**
 * A short list of actions laid out in place, not in a popover: React Aria's menu (arrow keys,
 * Enter, typeahead) drawn as 32px rows. A row is its 15px icon, 10px, then its 13px label, 8px
 * in from each side. One `secondary` fill springs between the rows under the pointer or keys
 * (the magnetic hover); the rows paint none of their own.
 */
export function ActionList<T extends object>({ className, ...props }: MenuProps<T>) {
  const hover = useMagneticHover({ itemSelector: ITEM_SELECTOR });

  return (
    <div className="relative" {...hover.containerProps}>
      <FluidHoverHighlight {...hover.highlightProps} className="bg-secondary" />
      <MenuPrimitive {...props} className={cx("flex flex-col gap-0.5 outline-hidden", className)} />
    </div>
  );
}

export function ActionItem({ className, ...props }: MenuItemProps) {
  return (
    <MenuItemPrimitive
      {...props}
      className={cx(
        "relative flex h-8 cursor-default items-center gap-2.5 px-2 text-sm text-foreground outline-hidden select-none",
        "*:[svg]:size-icon *:[svg]:shrink-0 *:[svg]:text-foreground",
        className,
      )}
    />
  );
}
