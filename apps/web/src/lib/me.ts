// Who is signed in: its own small module, so the entry chunk can start the request (main.tsx)
// without pulling in the rest of the app's hooks.
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { api, type Me } from "./api";

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => api<Me>("/api/me"),
  retry: false,
});

/**
 * Starts loading who is signed in before the page's own code has downloaded, so the wall's
 * chunk and `/api/me` arrive together instead of one after the other.
 */
export function prefetchMe(client: QueryClient) {
  void client.prefetchQuery(meQuery);
}
