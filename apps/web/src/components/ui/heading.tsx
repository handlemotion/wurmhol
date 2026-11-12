import { cn } from "cn";

export type HeadingType = { level?: 1 | 2 | 3 | 4 } & React.ComponentPropsWithoutRef<
  "h1" | "h2" | "h3" | "h4"
>;

export interface HeadingProps extends HeadingType {
  className?: string | undefined;
  /** `md` is the default; `sm` is a step down, for a title that stands alone over a form. */
  size?: "md" | "sm";
}

export function Heading({ className, level = 1, size = "md", ...props }: HeadingProps) {
  const Element: `h${typeof level}` = `h${level}`;

  return (
    <Element
      className={cn(size === "md" ? "text-lg" : "text-base", "text-foreground", className)}
      {...props}
    />
  );
}
