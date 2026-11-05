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
import type { Token, TokenExpiry } from "@/lib/api";
import { ago, expiry } from "@/lib/time";

const EXPIRIES: { key: string; days: TokenExpiry; label: string }[] = [
  { key: "30", days: 30, label: "30 days" },
  { key: "90", days: 90, label: "90 days" },
  { key: "never", days: null, label: "Never" },
];

/**
 * Tokens (spec section 3, ADR 0008): create one (shown once) with an expiry and a scope; list
 * by name, scope, expiry and last use; revoke. Computers approved with `wurmhol login` hold a
 * token too: they are listed apart, by when they were approved and last used, and signing one
 * out revokes its token, which also ends its open pipes.
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
          // What a Claude Code cloud environment needs (ADR 0008): the token, the install's URL
          // when it is not the CLI's default, and the one host the CLI dials. Each field keeps its
          // line 8px below it; the pairs sit 16px apart, and the shared label width lines up the
          // dividers.
          <div className="flex flex-col gap-4 [--copy-label-width:4.5rem]">
            <div className="flex flex-col gap-2">
              <CopyField label="Variable" value={`WURMHOL_TOKEN=${create.data.token}`} />
              <Text className="text-xs text-muted-foreground">
                Shown once. Paste it under Environment variables.
              </Text>
            </div>
            {create.data.url && (
              <div className="flex flex-col gap-2">
                <CopyField label="Server" value={`WURMHOL_URL=${create.data.url}`} />
                <Text className="text-xs text-muted-foreground">
                  Paste it there too: this install’s address.
                </Text>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <CopyField label="Host" value={create.data.host} />
              <Text className="text-xs text-muted-foreground">
                Add it under Network access, Allowed domains.
              </Text>
            </div>
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
              source: "console",
              createdAt: "",
              expiresAt: null,
              lastUsedAt: null,
              createdBy: null,
            },
          ]}
          label="Loading tokens"
        >
          {(list) => {
            const computers = list.filter((token) => token.source === "login");
            const made = list.filter((token) => token.source !== "login");
            const pending = (token: Token) => revoke.isPending && revoke.variables === token.id;
            return (
              <>
                {made.length > 0 && (
                  <ul className="flex flex-col divide-y divide-border">
                    {made.map((token) => (
                      <Row
                        key={token.id}
                        name={token.name}
                        detail={[
                          token.scope === "org" ? "All org pipes" : "Opens pipes",
                          expiry(token.expiresAt, now),
                          used(token, now),
                        ]}
                        action="Revoke"
                        isPending={pending(token)}
                        onPress={() => revoke.mutate(token.id)}
                      />
                    ))}
                  </ul>
                )}
                {computers.length > 0 && (
                  // A label belongs to the rows under it: more room above than below.
                  <section aria-label="Signed-in computers" className="flex flex-col gap-1 pt-3">
                    <span aria-hidden className="text-xs text-subtle-foreground">
                      Signed-in computers
                    </span>
                    <ul className="flex flex-col divide-y divide-border">
                      {computers.map((token) => (
                        <Row
                          key={token.id}
                          name={token.name}
                          detail={[
                            `Signed in ${ago(token.createdAt, now)}${token.createdBy ? ` by ${token.createdBy}` : ""}`,
                            used(token, now),
                          ]}
                          action="Sign out"
                          isPending={pending(token)}
                          onPress={() => revoke.mutate(token.id)}
                        />
                      ))}
                    </ul>
                  </section>
                )}
              </>
            );
          }}
        </Skeleton>
      </DialogBody>
    </Dialog>
  );
}

function used(token: Token, now: number) {
  return token.lastUsedAt ? `Used ${ago(token.lastUsedAt, now)}` : "Never used";
}

/** One token or computer: its name, a quiet line of detail, and the button that ends it. */
function Row({
  name,
  detail,
  action,
  isPending,
  onPress,
}: {
  name: string;
  detail: (string | null)[];
  action: string;
  isPending: boolean;
  onPress: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {detail.filter(Boolean).join(" · ")}
        </span>
      </div>
      <Button intent="danger" size="xs" isPending={isPending} onPress={onPress}>
        {action}
      </Button>
    </li>
  );
}
