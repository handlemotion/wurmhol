import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Whether this install has a GitHub App, and the accounts the org linked (ADR 0013). */
export function useGithub(enabled: boolean) {
  return useQuery({
    queryKey: ["github"],
    queryFn: () => api<{ available: boolean; installations: { account: string }[] }>("/api/github"),
    enabled,
    staleTime: 60_000,
  });
}
