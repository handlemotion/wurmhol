import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Join } from "./components/auth/join";
import { Login } from "./components/auth/login";
import { WallPage } from "./components/wall/wall";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 10_000 } },
});

/** Three pages: login, an invite link, and the wall. The server sends every other path here too. */
function Page() {
  const path = location.pathname;
  if (path === "/login") return <Login />;
  const join = /^\/join\/([^/]+)$/.exec(path);
  if (join) return <Join code={decodeURIComponent(join[1]!)} />;
  return <WallPage />;
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>
  </StrictMode>,
);
