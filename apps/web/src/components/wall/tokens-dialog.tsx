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
import { useCreateToken, useNow, useRevokeToken, useTokens } from "@/hooks/use-app";
import type { TokenExpiry } from "@/lib/api";
import { ago, expiry } from "@/lib/time";

const EXPIRIES: { key: string; days: TokenExpiry; label: string }[] = [
  { key: "30", days: 30, label: "30 days" },
  { key: "90", days: 90, label: "90 days" },
  { key: "never", days: null, label: "Never" },
];

/**
 * Tokens (spec section 3, ADR 0008): create one (shown once) with an expiry and a scope; list
 * by name, scope, expiry and last use; revoke.
 */
export function TokensDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tokens = useTokens(isOpen);
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const now = useNow();
  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState("90");
  const [orgScope, setOrgScope] = useState(false);
  const reset = () => {
    setName("");
    setExpiresIn("90");
    setOrgScope(false);
  };

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
        <DialogTitle>Tokens</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              {
                name,
                scope: orgScope ? "org" : "pipes",
                expiresInDays: EXPIRIES.find((e) => e.key === expiresIn)!.days,
              },
              { onSuccess: reset },
            );
          }}
        >
          <div className="flex gap-2">
            <TextField
              aria-label="Token name"
              isRequired
              value={name}
              onChange={setName}
              className="flex-1"
            >
              <Input placeholder="Name, like “cloud sessions”" />
            </TextField>
            <Button type="submit" isPending={create.isPending}>
              Create
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <ToggleGroup
              aria-label="Expires after"
              selectedKeys={[expiresIn]}
              onSelectionChange={(keys) => {
                const [key] = keys;
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
            <Checkbox isSelected={orgScope} onChange={setOrgScope}>
              Can list and close every pipe in the org
            </Checkbox>
          </div>
        </form>
        {create.data && (
          <div className="flex flex-col gap-2">
            <CopyField label="WURMHOL_TOKEN" value={create.data.token} />
            <Text className="text-xs text-muted-foreground">
              Shown once. Set it where your agent runs.
            </Text>
          </div>
        )}
        <Skeleton
          id="tokens"
          data={tokens.data?.tokens}
          sample={[
            {
              id: "a",
              name: "cloud sessions",
              scope: "pipes",
              createdAt: "",
              expiresAt: null,
              lastUsedAt: null,
              createdBy: null,
            },
          ]}
          label="Loading tokens"
        >
          {(list) =>
            list.length === 0 ? null : (
              <ul className="flex flex-col divide-y divide-border">
                {list.map((token) => (
                  <li key={token.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-foreground">{token.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {[
                          token.scope === "org" ? "All org pipes" : "Opens pipes",
                          expiry(token.expiresAt, now),
                          token.lastUsedAt ? `Used ${ago(token.lastUsedAt, now)}` : "Never used",
                        ].join(" · ")}
                      </span>
                    </div>
                    <Button
                      intent="danger"
                      size="xs"
                      isPending={revoke.isPending && revoke.variables === token.id}
                      onPress={() => revoke.mutate(token.id)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )
          }
        </Skeleton>
      </DialogBody>
    </Dialog>
  );
}
