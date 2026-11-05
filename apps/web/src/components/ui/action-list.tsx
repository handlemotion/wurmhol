import {
  Menu as MenuPrimitive,
  MenuItem as MenuItemPrimitive,
  type MenuItemProps,
  type MenuProps,
} from "react-aria-components/Menu";
import { cx } from "@/lib/primitive";

/**
 * A short list of actions laid out in place, not in a popover: React Aria's menu (arrow keys,
 * Enter, typeahead) drawn as 32px rows. A row is its 15px icon, 10px, then its 13px label, 8px
 * in from each side; the pointer or keyboard fills it with `secondary`.
 */
export function ActionList<T extends object>({ className, ...props }: MenuProps<T>) {
  return (
    <MenuPrimitive
      {...props}
      className={cx("flex flex-col gap-0.5 outline-hidden", className as string)}
    />
  );
}

export function ActionItem({ className, ...props }: MenuItemProps) {
  return (
    <MenuItemPrimitive
      {...props}
      className={cx(
        "flex h-8 cursor-default items-center gap-2.5 px-2 text-sm text-foreground outline-hidden select-none",
        "transition-[background-color] duration-150 ease-out motion-reduce:transition-none",
        "focus:bg-secondary",
        "*:[svg]:size-icon *:[svg]:shrink-0 *:[svg]:text-foreground",
        className as string,
      )}
    />
  );
}
