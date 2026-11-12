import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import {
  useBilling,
  useCreateOrg,
  useDeleteOrg,
  useLeaveOrg,
  useRenameOrg,
  useSetSpendCap,
} from "@/hooks/use-app";

/** The org actions in the switcher menu, each confirmed in a small dialog. */
export type OrgAction = "create" | "settings" | "delete";

/**
 * Start a new org, or open the active one's settings (rename, leave) or delete it (spec section 3,
 * header menu). Leaving and deleting say what happens on the button itself, in red: neither can be
 * undone from here.
 */
export function OrgDialog({
  action,
  orgName,
  isOwner,
  onClose,
}: {
  action: OrgAction | null;
  orgName: string;
  isOwner: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      isOpen={action !== null}
      onOpenChange={(open) => !open && onClose()}
      size="md"
      role={action === "delete" ? "alertdialog" : "dialog"}
    >
      {action === "create" && <Create onDone={onClose} />}
      {action === "settings" && <Settings orgName={orgName} isOwner={isOwner} onDone={onClose} />}
      {action === "delete" && <Delete orgName={orgName} onDone={onClose} />}
    </Dialog>
  );
}

function Failure({ error }: { error: Error | null }) {
  return error ? <Text className="text-danger-subtle-foreground">{error.message}</Text> : null;
}

/** Names the new org; creating it switches to it, so the wall behind the dialog is its own. */
function Create({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const create = useCreateOrg();

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(name, { onSuccess: onDone });
      }}
    >
      <DialogHeader>
        <DialogTitle>New org</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <TextField aria-label="Org name" isRequired autoFocus value={name} onChange={setName}>
          <Input maxLength={80} placeholder="Org name" />
        </TextField>
        <Failure error={create.error} />
      </DialogBody>
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <Button type="submit" isPending={create.isPending} isDisabled={!name.trim()}>
          Create org
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The active org's settings: its name, which owners change, and leaving it. Leaving sits apart
 * below a divider, in red, since it can't be undone from here.
 */
function Settings({
  orgName,
  isOwner,
  onDone,
}: {
  orgName: string;
  isOwner: boolean;
  onDone: () => void;
}) {
  const [name, setName] = useState(orgName);
  const rename = useRenameOrg();
  const leave = useLeaveOrg();
  const changed = name.trim() !== "" && name.trim() !== orgName;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Org settings</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-5">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate(name, { onSuccess: onDone });
          }}
        >
          <div className="flex gap-2">
            <TextField
              aria-label="Org name"
              isRequired
              isDisabled={!isOwner}
              value={name}
              onChange={setName}
              className="flex-1"
            >
              <Input maxLength={80} />
            </TextField>
            {isOwner && (
              <Button type="submit" isPending={rename.isPending} isDisabled={!changed}>
                Save
              </Button>
            )}
          </div>
          <Failure error={rename.error} />
        </form>
        {isOwner && <SpendCap />}
        <Separator />
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Text className="text-foreground">Leave org</Text>
            <Text>You lose its pipes and tokens. Getting back in takes a new invite link.</Text>
          </div>
          <Button
            intent="danger"
            className="shrink-0"
            isPending={leave.isPending}
            onPress={() => leave.mutate(undefined, { onSuccess: onDone })}
          >
            Leave org
          </Button>
        </div>
        <Failure error={leave.error} />
      </DialogBody>
    </>
  );
}

function Delete({ orgName, onDone }: { orgName: string; onDone: () => void }) {
  const remove = useDeleteOrg();

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete {orgName}?</DialogTitle>
        <DialogDescription>
          Its open pipes end now, and its tokens, members and history are deleted. This can’t be
          undone.
        </DialogDescription>
      </DialogHeader>
      <Failure error={remove.error} />
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <Button
          intent="danger"
          isPending={remove.isPending}
          onPress={() => remove.mutate(undefined, { onSuccess: onDone })}
        >
          Delete {orgName} for everyone
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Business's monthly spend cap (ADR 0027), in whole dollars: pipes stop at the requests that
 * would take the bill past it. Shown to owners on Business only.
 */
function SpendCap() {
  const billing = useBilling(true);
  const cap = billing.data?.spendCap;
  const set = useSetSpendCap();
  const [dollars, setDollars] = useState<string | null>(null);

  if (!cap) return null;
  const value = dollars ?? String(cap.cents / 100);
  const cents = Math.round(Number(value) * 100);
  const changed = Number.isFinite(cents) && cents !== cap.cents;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        set.mutate(cents, { onSuccess: () => setDollars(null) });
      }}
    >
      <div className="flex items-end gap-2">
        <TextField value={value} onChange={setDollars} className="flex-1">
          <Label>Monthly spend cap, USD</Label>
          <Input inputMode="decimal" />
        </TextField>
        <Button type="submit" isPending={set.isPending} isDisabled={!changed}>
          Save
        </Button>
      </div>
      <Failure error={set.error} />
    </form>
  );
}
