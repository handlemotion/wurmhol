import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  api,
  type Member,
  type Share,
  type SignInMethods,
  type Token,
  type TokenExpiry,
  type TokenScope,
} from "@/lib/api";
import { earlyShares, takeWall } from "@/lib/live";
import { meQuery } from "@/lib/me";

export const keys = {
  me: meQuery.queryKey,
  methods: ["sign-in-methods"] as const,
  tokens: ["tokens"] as const,
  members: ["members"] as const,
};

export function useMe() {
  return useQuery(meQuery);
}

/**
 * The Worker writes the sign-in methods into the page it serves (`#sign-in-methods`), so the
 * login form renders complete on its first paint. Without them (the Vite dev server), the
 * query fetches as usual.
 */
function inlineSignInMethods(): SignInMethods | undefined {
  const text = document.getElementById("sign-in-methods")?.textContent;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as SignInMethods;
  } catch {
    return undefined;
  }
}

export function useSignInMethods() {
  const inline = inlineSignInMethods();
  return useQuery({
    queryKey: keys.methods,
    queryFn: () => api<SignInMethods>("/api/sign-in-methods"),
    initialData: inline,
    staleTime: inline ? Infinity : 0,
  });
}

/**
 * The active org's open shares, live (`lib/live.ts`). The first wall adopts the socket opened at
 * startup, so a snapshot that already arrived renders on the first frame, with no skeleton.
 */
export function useWall(orgId: string | null) {
  const [shares, setShares] = useState<Share[] | undefined>(earlyShares);
  useEffect(() => {
    if (!orgId) return;
    const wall = takeWall();
    setShares(wall.shares);
    wall.listen(setShares);
    return () => wall.close();
  }, [orgId]);
  return shares;
}

export function useTerminate() {
  return useMutation({
    mutationFn: (id: string) => api(`/api/shares/${id}/terminate`, { method: "POST" }),
  });
}

const tokensQuery = queryOptions({
  queryKey: keys.tokens,
  queryFn: () => api<{ tokens: Token[] }>("/api/tokens"),
});

export function useTokens(enabled: boolean) {
  return useQuery({ ...tokensQuery, enabled });
}

export function useCreateToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; scope: TokenScope; expiresInDays: TokenExpiry }) =>
      api<{ id: string; token: string; host: string; url: string | null }>("/api/tokens", {
        method: "POST",
        body,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.tokens }),
  });
}

export function useRevokeToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.tokens }),
  });
}

const membersQuery = queryOptions({
  queryKey: keys.members,
  queryFn: () => api<{ members: Member[]; you: string }>("/api/members"),
});

export function useMembers(enabled: boolean) {
  return useQuery({ ...membersQuery, enabled });
}

/**
 * Loads what the menu's dialogs show as soon as the menu opens, so Members and Tokens open on
 * their lists instead of a skeleton. Data that's fresh (`staleTime`) isn't fetched again.
 */
export function usePrefetchDialogs() {
  const client = useQueryClient();
  return () => {
    void client.prefetchQuery(membersQuery);
    void client.prefetchQuery(tokensQuery);
  };
}

export function useRemoveMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/members/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.members }),
  });
}

export function useCreateInvite() {
  return useMutation({
    mutationFn: () => api<{ url: string; expiresAt: string }>("/api/invites", { method: "POST" }),
  });
}

export function useSwitchOrg() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (organizationId: string) => {
      const { setActiveOrg } = await import("@/lib/auth");
      await setActiveOrg(organizationId);
    },
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSignOut() {
  return useMutation({
    mutationFn: async () => {
      const { signOut } = await import("@/lib/auth");
      await signOut();
      location.assign("/login");
    },
  });
}

/** Re-renders every `ms`, for relative times on the wall. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Billing: the Stripe portal when the org has a plan, Checkout when it has none. */
export function useOpenBilling() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api<{ url: string }>("/api/billing/open", { method: "POST", body: {} });
      location.assign(url);
    },
  });
}
