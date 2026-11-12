import { useState } from "react";
import { Skeleton } from "skullet/react";
import { IconCrown, IconEllipsis, IconTrash, IconUser } from "@/components/icons/lucide";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Text } from "@/components/ui/text";
import {
  useCreateInvite,
  useMembers,
  useRemoveMember,
  useSetRole,
  useTransferOrg,
} from "@/hooks/use-app";
import type { Me, Member } from "@/lib/api";
import { initials } from "@/lib/initials";

/**
 * Members (spec section 3): list, invite by copyable link, remove. Owners invite, remove, change
 * roles and hand the org over, from a menu on each other member's row.
 */
export function MembersDialog({
  me,
  isOpen,
  onOpenChange,
}: {
  me: Me;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const members = useMembers(isOpen);
  const invite = useCreateInvite();
  const remove = useRemoveMember();
  const setRole = useSetRole();
  const [handOver, setHandOver] = useState<Member | null>(null);
  const owner = me.role === "owner";
  const failure = invite.error ?? setRole.error ?? remove.error;

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) invite.reset();
        onOpenChange(open);
      }}
      size="lg"
    >
      <DialogHeader>
        <DialogTitle>Members</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5">
        {owner &&
          (invite.data ? (
            <CopyField label="Invite link" value={invite.data.url} />
          ) : (
            <Button intent="outline" isPending={invite.isPending} onPress={() => invite.mutate()}>
              Create an invite link
            </Button>
          ))}
        <Skeleton
          id="members"
          data={members.data}
          sample={{
            you: "",
            members: [
              {
                id: "a",
                userId: "a",
                name: "Someone",
                email: "someone@example.com",
                image: null,
                role: "owner",
              },
            ],
          }}
          label="Loading members"
        >
          {(data) => (
            <ul className="flex flex-col divide-y divide-border">
              {data.members.map((member) => (
                <li key={member.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar
                      size="md"
                      src={member.image}
                      initials={initials(member.name, member.email)}
                      alt=""
                    />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-foreground">
                        {member.name || member.email}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[member.name && member.email, member.role === "owner" ? "Owner" : "Member"]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </div>
                  {owner && member.id !== data.you && (
                    <MenuTrigger>
                      <Button
                        intent="plain"
                        size="sq-xs"
                        aria-label={`Manage ${member.name || member.email}`}
                        isPending={
                          (remove.isPending && remove.variables === member.id) ||
                          (setRole.isPending && setRole.variables?.id === member.id)
                        }
                      >
                        <IconEllipsis />
                      </Button>
                      <Menu
                        placement="bottom end"
                        onAction={(key) => {
                          if (key === "role") {
                            setRole.mutate({
                              id: member.id,
                              role: member.role === "owner" ? "member" : "owner",
                            });
                          } else if (key === "transfer") setHandOver(member);
                          else if (key === "remove") remove.mutate(member.id);
                        }}
                      >
                        <MenuItem id="role">
                          {member.role === "owner" ? <IconUser /> : <IconCrown />}
                          <MenuLabel>
                            {member.role === "owner" ? "Make a member" : "Make an owner"}
                          </MenuLabel>
                        </MenuItem>
                        <MenuItem id="transfer">
                          <IconCrown />
                          <MenuLabel>Transfer ownership</MenuLabel>
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem id="remove" intent="danger">
                          <IconTrash />
                          <MenuLabel>Remove from org</MenuLabel>
                        </MenuItem>
                      </Menu>
                    </MenuTrigger>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Skeleton>
        {failure && <Text className="text-danger-subtle-foreground">{failure.message}</Text>}
      </DialogBody>
      <TransferDialog member={handOver} onClose={() => setHandOver(null)} />
    </Dialog>
  );
}

/** Hands the org to another member: they become its owner, and you a member. */
function TransferDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const transfer = useTransferOrg();
  const who = member ? member.name || member.email : "";

  return (
    <Dialog
      isOpen={member !== null}
      onOpenChange={(open) => {
        if (!open) {
          transfer.reset();
          onClose();
        }
      }}
      size="md"
      role="alertdialog"
    >
      <DialogHeader>
        <DialogTitle>Transfer ownership to {who}?</DialogTitle>
        <DialogDescription>
          {who} becomes an owner and you become a member: you can no longer manage members, billing
          or the org.
        </DialogDescription>
      </DialogHeader>
      {transfer.error && (
        <Text className="text-danger-subtle-foreground">{transfer.error.message}</Text>
      )}
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <Button
          isPending={transfer.isPending}
          onPress={() => member && transfer.mutate(member.id, { onSuccess: onClose })}
        >
          Make {who} the owner
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
