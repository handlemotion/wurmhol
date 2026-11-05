import { useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { useCreateToken, useNow, useRevokeToken, useTokens } from "@/hooks/use-app";
import { ago } from "@/lib/time";

/** Tokens (spec section 3): create one (shown once), list by name and last use, revoke. */
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

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          create.reset();
          setName("");
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
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(name, { onSuccess: () => setName("") });
          }}
        >
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
        </form>
        {create.data && (
          // What a Claude Code cloud environment needs (ADR 0008): the token, the install's URL
          // when it is not the CLI's default, and the one host the CLI dials. Each field keeps its line 8px below it; the pairs sit 16px apart, and
          // the shared label width lines up the two dividers.
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
            { id: "a", name: "cloud sessions", createdAt: "", lastUsedAt: null, createdBy: null },
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
                        {token.lastUsedAt ? `Used ${ago(token.lastUsedAt, now)}` : "Never used"}
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
