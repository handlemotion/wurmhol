import { cn } from "cn";
import { useState } from "react";

const AVATAR_SIZES = {
  xs: "[--avatar-size:--spacing(5)]",
  sm: "[--avatar-size:--spacing(6)]",
  md: "[--avatar-size:--spacing(8)]",
  lg: "[--avatar-size:--spacing(10)]",
  xl: "[--avatar-size:--spacing(12)]",
  "2xl": "[--avatar-size:--spacing(14)]",
  "3xl": "[--avatar-size:--spacing(16)]",
  "4xl": "[--avatar-size:--spacing(20)]",
  "5xl": "[--avatar-size:--spacing(24)]",
  "6xl": "[--avatar-size:--spacing(28)]",
  "7xl": "[--avatar-size:--spacing(32)]",
  "8xl": "[--avatar-size:--spacing(36)]",
  "9xl": "[--avatar-size:--spacing(42)]",
};

export interface AvatarProps {
  src?: string | null;
  initials?: string;
  alt?: string;
  className?: string;
  isSquare?: boolean;
  size?: keyof typeof AVATAR_SIZES;
}

export function Avatar({
  src = null,
  isSquare = false,
  size = "md",
  initials,
  alt = "",
  className,
  ...props
}: AvatarProps & React.ComponentPropsWithoutRef<"span">) {
  // A picture that fails to load (gone, blocked, offline) leaves the initials showing instead of
  // the browser's broken-image glyph over them.
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <span
      data-slot="avatar"
      {...props}
      className={cn(
        "inline-grid size-(--avatar-size) shrink-0 align-middle outline-1 outline-foreground/(--ring-opacity) -outline-offset-1 [--avatar-radius:0] [--ring-opacity:20%] *:col-start-1 *:row-start-1 *:size-(--avatar-size)",
        AVATAR_SIZES[size],
        isSquare
          ? "rounded-(--avatar-radius) *:rounded-(--avatar-radius)"
          : "rounded-none *:rounded-none",
        className,
      )}
    >
      {initials && (
        <svg
          className="size-full select-none fill-current p-[5%] font-md text-[48px] uppercase"
          viewBox="0 0 100 100"
          aria-hidden={alt ? undefined : "true"}
        >
          {alt && <title>{alt}</title>}
          <text
            x="50%"
            y="50%"
            alignmentBaseline="middle"
            dominantBaseline="middle"
            textAnchor="middle"
            // Optical centre: the ink sits a hair above the disc's middle, where the eye reads
            // centre (measured: .125em left capitals 0.4px below the middle, reading ~1px low).
            dy=".07em"
          >
            {initials}
          </text>
        </svg>
      )}
      {src && src !== failed && (
        <img
          className="size-full object-cover object-center"
          src={src}
          alt={alt}
          onError={() => setFailed(src)}
        />
      )}
    </span>
  );
}
