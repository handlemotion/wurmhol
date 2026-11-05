import { Skeleton } from "skullet/react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCreateInvite, useMembers, useRemoveMember } from "@/hooks/use-app";
import type { Me } from "@/lib/api";

function initials(name: string, email: string) {
  const source = name.trim() || email;
  return source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/** Members (spec section 3): list, invite by copyable link, remove. Owners invite and remove. */
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
  const owner = me.role === "owner";

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
                        {member.name ? `${member.email} · ${member.role}` : member.role}
                      </span>
                    </div>
                  </div>
                  {owner && member.id !== data.you && (
                    <Button
                      intent="danger"
                      size="xs"
                      isPending={remove.isPending && remove.variables === member.id}
                      onPress={() => remove.mutate(member.id)}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Skeleton>
      </DialogBody>
    </Dialog>
  );
}
