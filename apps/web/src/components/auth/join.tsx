import { useMutation, useQuery } from "@tanstack/react-query";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { Text } from "@/components/ui/text";
import { api, isSignedOut, toLogin } from "@/lib/api";

/** An invite link (`/join/<code>`): join the org as a member, after signing in. */
export function Join({ code }: { code: string }) {
  const invite = useQuery({
    queryKey: ["invite", code],
    queryFn: () => api<{ orgName: string }>(`/api/invites/${encodeURIComponent(code)}`),
    retry: false,
  });
  const join = useMutation({
    mutationFn: () => api(`/api/invites/${encodeURIComponent(code)}/accept`, { method: "POST" }),
    onSuccess: () => location.assign("/"),
    onError: (error) => {
      if (isSignedOut(error)) toLogin();
    },
  });

  return (
    <SkeletonProvider>
      <main className="flex min-h-dvh items-center justify-center bg-surface px-4">
        <div className="flex w-full max-w-100 flex-col pb-12">
          <Card className="gap-6 p-6">
            {invite.isError ? (
              <Text>This invite link has expired or was already used. Ask for a new one.</Text>
            ) : (
              <Skeleton
                id="join-invite"
                data={invite.data}
                sample={{ orgName: "Handlemotion" }}
                label="Loading invite"
              >
                {(data) => (
                  <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-2">
                      <Heading>Join {data.orgName}</Heading>
                      <Text>You'll see and open every pipe its members start.</Text>
                    </div>
                    <Button size="lg" isPending={join.isPending} onPress={() => join.mutate()}>
                      Join {data.orgName}
                    </Button>
                  </div>
                )}
              </Skeleton>
            )}
          </Card>
        </div>
      </main>
    </SkeletonProvider>
  );
}
