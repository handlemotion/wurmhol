// Embedded applications (ADR 0032) as the console reads and changes them: `/api/apps`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type App,
  type AppKey,
  type AppPermission,
  type AppSettings,
  type AppTunnel,
} from "@/lib/api";

const keys = {
  apps: ["apps"] as const,
  keys: (app: string) => ["apps", app, "keys"] as const,
  tunnels: (app: string) => ["apps", app, "tunnels"] as const,
};

export function useApps(enabled: boolean) {
  return useQuery({
    queryKey: keys.apps,
    queryFn: () => api<{ apps: App[] }>("/api/apps"),
    enabled,
    // The open-pipe counts move as agents connect: the island keeps them roughly current.
    refetchInterval: 15_000,
  });
}

export function useCreateApp() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: { name: string }) =>
      api<{ app: App }>("/api/apps", { method: "POST", body }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.apps }),
  });
}

export function useUpdateApp(id: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: Partial<AppSettings>) =>
      api<{ app: App }>(`/api/apps/${id}`, { method: "PATCH", body }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.apps }),
  });
}

export function useDeleteApp() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api(`/api/apps/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.apps }),
  });
}

export function useAppKeys(app: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.keys(app),
    queryFn: () => api<{ keys: AppKey[] }>(`/api/apps/${app}/keys`),
    enabled,
  });
}

export function useCreateAppKey(app: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: {
      name: string;
      permissions: AppPermission[];
      expiresInDays: 30 | 90 | 365 | null;
    }) =>
      api<{ id: string; key: string; permissions: AppPermission[] }>(`/api/apps/${app}/keys`, {
        method: "POST",
        body,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.keys(app) }),
  });
}

export function useRevokeAppKey(app: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (key: string) => api(`/api/apps/${app}/keys/${key}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.keys(app) }),
  });
}

export function useAppTunnels(app: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.tunnels(app),
    queryFn: () => api<{ tunnels: AppTunnel[] }>(`/api/apps/${app}/tunnels`),
    enabled,
    refetchInterval: 15_000,
  });
}

/** Stops a pipe (its agent may open it again) or deletes it for good. */
export function useEndTunnel(app: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ tunnel, how }: { tunnel: string; how: "stop" | "delete" }) =>
      how === "stop"
        ? api(`/api/apps/${app}/tunnels/${tunnel}/stop`, { method: "POST" })
        : api(`/api/apps/${app}/tunnels/${tunnel}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.tunnels(app) });
      void client.invalidateQueries({ queryKey: keys.apps });
    },
  });
}
