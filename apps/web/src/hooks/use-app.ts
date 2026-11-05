import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  api,
  type Me,
  type Member,
  type Share,
  type SignInMethods,
  type Token,
  type WallEvent,
} from "@/lib/api";
import { setActiveOrg, signOut } from "@/lib/auth";

export const keys = {
  me: ["me"] as const,
  methods: ["sign-in-methods"] as const,
  tokens: ["tokens"] as const,
  members: ["members"] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api<Me>("/api/me"), retry: false });
}

export function useSignInMethods() {
  return useQuery({
    queryKey: keys.methods,
    queryFn: () => api<SignInMethods>("/api/sign-in-methods"),
  });
}

/**
 * The active org's open shares, live: the Org Durable Object pushes a snapshot, then every start,
 * change and end (spec section 3, no polling). Reconnects with backoff if the socket drops.
 */
export function useWall(orgId: string | null) {
  const [shares, setShares] = useState<Share[] | undefined>(undefined);
  useEffect(() => {
    if (!orgId) return;
    let socket: WebSocket | null = null;
    let stopped = false;
    let delay = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const url = new URL("/api/live", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onmessage = (message) => {
        delay = 500;
        const event = JSON.parse(String(message.data)) as WallEvent;
        setShares((current) => {
          if (event.type === "snapshot") return event.shares;
          const list = current ?? [];
          if (event.type === "share.ended") return list.filter((s) => s.id !== event.id);
          const others = list.filter((s) => s.id !== event.share.id);
          return [event.share, ...others].toSorted((a, b) => b.startedAt - a.startedAt);
        });
      };
      socket.onclose = () => {
        if (stopped) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
    };
    setShares(undefined);
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [orgId]);
  return shares;
}

export function useTerminate() {
  return useMutation({
    mutationFn: (id: string) => api(`/api/shares/${id}/terminate`, { method: "POST" }),
  });
}

export function useTokens(enabled: boolean) {
  return useQuery({
    queryKey: keys.tokens,
    queryFn: () => api<{ tokens: Token[] }>("/api/tokens"),
    enabled,
  });
}

export function useCreateToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api<{ id: string; token: string; host: string }>("/api/tokens", {
        method: "POST",
        body: { name },
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

export function useMembers(enabled: boolean) {
  return useQuery({
    queryKey: keys.members,
    queryFn: () => api<{ members: Member[]; you: string }>("/api/members"),
    enabled,
  });
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
    mutationFn: (organizationId: string) => setActiveOrg(organizationId),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSignOut() {
  return useMutation({
    mutationFn: async () => {
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
