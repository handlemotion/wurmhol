import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  api,
  type AppConfig,
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
  config: ["app-config"] as const,
  tokens: ["tokens"] as const,
  members: ["members"] as const,
};

export function useMe() {
  return useQuery(meQuery);
}

/**
 * The Worker writes the sign-in methods (`#sign-in-methods`) and the app config (`#app-config`)
 * into the page it serves, so the login form and the wall render complete on their first paint.
 * Without them (the Vite dev server), the queries fetch as usual.
 */
function inline<T>(id: string): T | undefined {
  const text = document.getElementById(id)?.textContent;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function useAppConfig() {
  const config = inline<AppConfig>("app-config");
  return useQuery({
    queryKey: keys.config,
    queryFn: () => api<AppConfig>("/api/app-config"),
    initialData: config,
    staleTime: config ? Infinity : 0,
  });
}

export function useSignInMethods() {
  const methods = inline<SignInMethods>("sign-in-methods");
  return useQuery({
    queryKey: keys.methods,
    queryFn: () => api<SignInMethods>("/api/sign-in-methods"),
    initialData: methods,
    staleTime: methods ? Infinity : 0,
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

/** Changes that move what the whole page shows (org name, role, which org): refetch it all. */
function useOrgChange<T>(mutationFn: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => client.invalidateQueries() });
}

export function useRenameOrg() {
  return useOrgChange((name: string) => api("/api/org", { method: "PATCH", body: { name } }));
}

export function useSetRole() {
  return useOrgChange(({ id, role }: { id: string; role: "owner" | "member" }) =>
    api(`/api/members/${id}/role`, { method: "POST", body: { role } }),
  );
}

export function useTransferOrg() {
  return useOrgChange((id: string) => api(`/api/members/${id}/transfer`, { method: "POST" }));
}

export function useLeaveOrg() {
  return useOrgChange(() => api("/api/org/leave", { method: "POST" }));
}

export function useDeleteOrg() {
  return useOrgChange(() => api("/api/org", { method: "DELETE" }));
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
