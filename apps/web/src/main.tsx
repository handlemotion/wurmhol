import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { preconnectWall } from "./lib/live";
import { prefetchMe } from "./lib/me";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 10_000 } },
});

// A tab left open across a deploy asks for chunks the new deploy no longer serves (sign-out
// loads the auth client on demand, for one). Reloading picks up the new build.
addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  location.reload();
});

const path = location.pathname;
const join = /^\/join\/([^/]+)$/.exec(path);
// The wall's data starts loading now, alongside its code, not after it.
if (path !== "/login" && path !== "/device" && path !== "/oauth/consent" && !join) {
  prefetchMe(queryClient);
  preconnectWall();
}

/**
 * Five pages: login, an invite link, a `wurmhol login` approval, an assistant's request to reach
 * the org's pipes (the hosted MCP server's consent), and the wall. The server sends
 * every other path here too. Each is its own chunk, so the login page never downloads the wall
 * and the wall never downloads the sign-in client. The page's chunk loads before the first render rather than behind
 * `lazy()`: React holds a Suspense reveal back up to 300 ms after its fallback, which would
 * delay every first paint.
 */
const page = (
  path === "/login"
    ? import("./components/auth/login").then(({ Login }) => <Login />)
    : path === "/device"
      ? import("./components/auth/device").then(({ Device }) => <Device />)
      : path === "/oauth/consent"
        ? import("./components/auth/consent").then(({ Consent }) => <Consent />)
        : join
          ? import("./components/auth/join").then(({ Join }) => (
              <Join code={decodeURIComponent(join[1]!)} />
            ))
          : import("./components/wall/wall").then(({ WallPage }) => <WallPage />)
) satisfies Promise<React.ReactNode>;

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>{await page}</QueryClientProvider>
  </StrictMode>,
);
