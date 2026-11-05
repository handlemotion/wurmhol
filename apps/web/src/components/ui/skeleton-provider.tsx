import { SkulletProvider } from "skullet/react";

/**
 * Settings for every skullet skeleton inside (DESIGN.md, Loading). Bars are sharp like the rest
 * of the app. Content replaces its skeleton in one crossfade: skullet's default reveal measures
 * and animates every piece on its own, which costs several frames of layout on a full wall.
 */
export function SkeletonProvider({ children }: { children: React.ReactNode }) {
  return (
    <SkulletProvider reveal="together" theme={{ radius: "0" }}>
      {children}
    </SkulletProvider>
  );
}
