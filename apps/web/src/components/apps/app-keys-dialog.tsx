import { useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyField } from "@/components/ui/copy-field";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useNow } from "@/hooks/use-app";
import { useAppKeys, useCreateAppKey, useRevokeAppKey } from "@/hooks/use-apps";
import type { App, AppKey, AppPermission } from "@/lib/api";
import { ago, expiry } from "@/lib/time";

const PERMISSIONS: { id: AppPermission; label: string }[] = [
  { id: "tunnels:read", label: "See pipes and usage" },
  { id: "tunnels:manage", label: "Create, stop and delete pipes" },
  { id: "subjects:manage", label: "Manage customers and users" },
  { id: "grants:issue", label: "Let users in" },
];

const EXPIRIES = [
  { key: "never", days: null, label: "Never" },
  { key: "365", days: 365, label: "1 year" },
  { key: "90", days: 90, label: "90 days" },
] as const;

/**
 * An app's integration keys (ADR 0032): make one for its backend, shown once, with what it may do;
 * list them by name, permissions, expiry and last use; revoke. Keys belong to the app, so they
 * keep working when the person who made one leaves the org.
 */
export function AppKeysDialog({
  app,
  isOpen,
  onOpenChange,
}: {
  app: App;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const keys = useAppKeys(app.id, isOpen);
  const create = useCreateAppKey(app.id);
  const revoke = useRevokeAppKey(app.id);
  const now = useNow();
  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState<string>("never");
  const [permissions, setPermissions] = useState<AppPermission[]>(PERMISSIONS.map((p) => p.id));
  const reset = () => {
    setName("");
    setExpiresIn("never");
    setPermissions(PERMISSIONS.map((p) => p.id));
  };
  const toggle = (id: AppPermission, on: boolean) =>
    setPermissions((current) => (on ? [...current, id] : current.filter((p) => p !== id)));

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          create.reset();
          reset();
        }
        onOpenChange(open);
      }}
      size="lg"
    >
      <DialogHeader>
        <DialogTitle>{app.name} keys</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              {
                name,
                permissions,
                expiresInDays: EXPIRIES.find((e) => e.key === expiresIn)!.days,
              },
              { onSuccess: reset },
            );
          }}
        >
          <div className="flex gap-2">
            <TextField
              aria-label="Key name"
              isRequired
              value={name}
              onChange={setName}
              className="flex-1"
            >
              <Input placeholder="Name, like “production backend”" />
            </TextField>
            <Button
              type="submit"
              isPending={create.isPending}
              isDisabled={permissions.length === 0}
            >
              Create
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {PERMISSIONS.map((permission) => (
              <Checkbox
                key={permission.id}
                isSelected={permissions.includes(permission.id)}
                onChange={(on) => toggle(permission.id, on)}
              >
                {permission.label}
              </Checkbox>
            ))}
          </div>
          <ToggleGroup
            aria-label="Expires after"
            selectedKeys={[expiresIn]}
            onSelectionChange={(selected) => {
              const [key] = selected;
              if (key !== undefined) setExpiresIn(String(key));
            }}
            className="w-full sm:w-auto"
          >
            {EXPIRIES.map((e) => (
              <ToggleGroupItem key={e.key} id={e.key}>
                {e.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </form>
        {create.data && (
          <div className="flex flex-col gap-2 [--copy-label-width:4.5rem]">
            <CopyField label="Key" value={create.data.key} />
            <Text className="text-xs text-muted-foreground">
              Shown once. Keep it on your server, never in a page or an app people install.
            </Text>
          </div>
        )}
        <Skeleton
          id={`app-keys-${app.id}`}
          data={keys.data?.keys}
          sample={[
            {
              id: "a",
              name: "production backend",
              permissions: ["grants:issue"],
              createdAt: "",
              expiresAt: null,
              lastUsedAt: null,
              createdBy: null,
            },
          ]}
          label="Loading keys"
        >
          {(list) =>
            list.length > 0 && (
              <ul className="flex flex-col divide-y divide-border">
                {list.map((key) => (
                  <Row
                    key={key.id}
                    appKey={key}
                    now={now}
                    isPending={revoke.isPending && revoke.variables === key.id}
                    onRevoke={() => revoke.mutate(key.id)}
                  />
                ))}
              </ul>
            )
          }
        </Skeleton>
      </DialogBody>
    </Dialog>
  );
}

function can(key: AppKey) {
  return key.permissions.length === PERMISSIONS.length
    ? "Everything"
    : PERMISSIONS.filter((p) => key.permissions.includes(p.id))
        .map((p) => p.label)
        .join(", ");
}

/** One key: its name, a quiet line of what it may do, expiry and use, and Revoke. */
function Row({
  appKey,
  now,
  isPending,
  onRevoke,
}: {
  appKey: AppKey;
  now: number;
  isPending: boolean;
  onRevoke: () => void;
}) {
  const used = appKey.lastUsedAt ? `Used ${ago(appKey.lastUsedAt, now)}` : "Never used";
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{appKey.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {[can(appKey), expiry(appKey.expiresAt, now), used].filter(Boolean).join(" · ")}
        </span>
      </div>
      <Button intent="danger" size="xs" isPending={isPending} onPress={onRevoke}>
        Revoke
      </Button>
    </li>
  );
}
