import { useState } from "react";
import { Skeleton } from "skullet/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { useAddDomain, useDomains, useRemoveDomain, useVerifyDomain } from "@/hooks/use-app";
import { ApiError, type Domain } from "@/lib/api";

const STATE: Record<
  Domain["state"],
  { label: string; intent: "secondary" | "info" | "success" | "danger" }
> = {
  pending: { label: "Waiting for DNS", intent: "secondary" },
  verifying: { label: "Getting a certificate", intent: "info" },
  active: { label: "Active", intent: "success" },
  failed: { label: "Failed", intent: "danger" },
};

/**
 * Custom domains (ADR 0033): your own hostname on a pipe name, so the pipe's URL is yours. Add
 * one, publish the two DNS records it shows, and it goes active once both are seen. Any member
 * may add and remove them, like tokens.
 */
export function DomainsDialog({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const domains = useDomains(isOpen);
  const add = useAddDomain();
  const [hostname, setHostname] = useState("");
  const [pipe, setPipe] = useState("");

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          add.reset();
          setHostname("");
          setPipe("");
        }

        onOpenChange(open);
      }}
      size="lg"
    >
      <DialogHeader>
        <DialogTitle>Domains</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(
              { hostname, pipe },
              {
                onSuccess: () => {
                  setHostname("");
                  setPipe("");
                },
              },
            );
          }}
        >
          <div className="flex gap-2">
            <TextField
              aria-label="Hostname"
              isRequired
              value={hostname}
              onChange={setHostname}
              className="flex-1"
            >
              <Input placeholder="Hostname, like preview.acme.dev" />
            </TextField>
            <TextField
              aria-label="Pipe name"
              isRequired
              value={pipe}
              onChange={setPipe}
              className="w-40"
            >
              <Input placeholder="Pipe name" />
            </TextField>
            <Button type="submit" isPending={add.isPending}>
              Add
            </Button>
          </div>
          {add.error && (
            <Text className="text-xs text-danger-subtle-foreground">{message(add.error)}</Text>
          )}
        </form>
        <Skeleton
          id="domains"
          data={domains.data?.domains}
          sample={[SAMPLE]}
          label="Loading domains"
        >
          {(list) =>
            list.length === 0 ? (
              <Text className="text-xs">
                No domains yet. A domain makes every pipe with its name open at your own hostname.
              </Text>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {list.map((domain) => (
                  <DomainRow key={domain.hostname} domain={domain} />
                ))}
              </ul>
            )
          }
        </Skeleton>
      </DialogBody>
    </Dialog>
  );
}

const SAMPLE: Domain = {
  hostname: "preview.example.com",
  pipe: "example",
  state: "active",
  url: null,
  dns: [],
  error: null,
  createdAt: "",
  verifiedAt: null,
  expiresAt: null,
};

function message(cause: unknown) {
  return cause instanceof ApiError ? cause.message : "Something went wrong. Try again.";
}

/** One domain: where it stands, the records it still needs, and what can be done to it. */
function DomainRow({ domain }: { domain: Domain }) {
  const verify = useVerifyDomain();
  const remove = useRemoveDomain();
  const state = STATE[domain.state];
  const waiting = domain.state === "pending" || domain.state === "verifying";

  return (
    <li className="flex flex-col gap-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-foreground">{domain.hostname}</span>
          <span className="truncate text-xs text-muted-foreground">
            Pipe name {domain.pipe}
            {domain.url ? ` · ${domain.url}` : ""}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge intent={state.intent}>{state.label}</Badge>
          {waiting && (
            <Button
              intent="secondary"
              size="xs"
              isPending={verify.isPending}
              onPress={() => verify.mutate(domain.hostname)}
            >
              Check now
            </Button>
          )}
          <Button
            intent="danger"
            size="xs"
            isPending={remove.isPending}
            onPress={() => remove.mutate(domain.hostname)}
          >
            Remove
          </Button>
        </div>
      </div>
      {domain.error && (
        <Text className="text-xs">
          {domain.error.message} {domain.error.fix}
        </Text>
      )}
      {remove.error && (
        // The domain is still set up and may still be served: say so, and why.
        <Text className="text-xs text-danger-subtle-foreground">
          Not removed. {message(remove.error)}
        </Text>
      )}
      {waiting && (
        // The two proofs (ADR 0033): the TXT record says the org owns the name, the CNAME sends
        // its traffic here. A record already seen turns green. The labels share one width so the
        // dividers line up.
        <div className="flex flex-col gap-2 [--copy-label-width:5.5rem]">
          <Text className="text-xs">Publish these at {domain.hostname}’s DNS host.</Text>
          {domain.dns.map((record) => (
            <div key={`${record.type}-${record.purpose}`} className="flex flex-col gap-1">
              <CopyField label={`${record.type} name`} value={record.name} done={record.done} />
              <CopyField label={`${record.type} value`} value={record.value} done={record.done} />
              <Text className="text-xs text-subtle-foreground">
                {record.purpose === "ownership"
                  ? "Proves you own this hostname."
                  : "Sends its traffic here and gets it a certificate."}
              </Text>
            </div>
          ))}
          {verify.error && (
            <Text className="text-xs text-danger-subtle-foreground">{message(verify.error)}</Text>
          )}
        </div>
      )}
    </li>
  );
}
