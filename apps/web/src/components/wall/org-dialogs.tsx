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
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { useCreateOrg, useDeleteOrg, useLeaveOrg, useRenameOrg } from "@/hooks/use-app";

/** The org actions in the switcher menu, each confirmed in a small dialog. */
export type OrgAction = "create" | "rename" | "leave" | "delete";

/**
 * Start a new org, or rename, leave or delete the active one (spec section 3, header menu). Leaving and deleting say
 * what happens on the button itself, in red: neither can be undone from here.
 */
export function OrgDialog({
  action,
  orgName,
  onClose,
}: {
  action: OrgAction | null;
  orgName: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      isOpen={action !== null}
      onOpenChange={(open) => !open && onClose()}
      size="md"
      role={action === "rename" || action === "create" ? "dialog" : "alertdialog"}
    >
      {action === "create" && <Create onDone={onClose} />}
      {action === "rename" && <Rename orgName={orgName} onDone={onClose} />}
      {action === "leave" && <Leave orgName={orgName} onDone={onClose} />}
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

function Rename({ orgName, onDone }: { orgName: string; onDone: () => void }) {
  const [name, setName] = useState(orgName);
  const rename = useRenameOrg();
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate(name, { onSuccess: onDone });
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename org</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <TextField aria-label="Org name" isRequired autoFocus value={name} onChange={setName}>
          <Input maxLength={80} />
        </TextField>
        <Failure error={rename.error} />
      </DialogBody>
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <Button type="submit" isPending={rename.isPending} isDisabled={!name.trim()}>
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}

function Leave({ orgName, onDone }: { orgName: string; onDone: () => void }) {
  const leave = useLeaveOrg();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Leave {orgName}?</DialogTitle>
        <DialogDescription>
          You lose its pipes and tokens. Getting back in takes a new invite link.
        </DialogDescription>
      </DialogHeader>
      <Failure error={leave.error} />
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <Button
          intent="danger"
          isPending={leave.isPending}
          onPress={() => leave.mutate(undefined, { onSuccess: onDone })}
        >
          Leave {orgName}
        </Button>
      </DialogFooter>
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
