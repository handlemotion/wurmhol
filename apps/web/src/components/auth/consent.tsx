import { useMutation, useQuery } from "@tanstack/react-query";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { Strong, Text } from "@/components/ui/text";
import { api, ApiError, type Me } from "@/lib/api";

/** What each scope lets the assistant do (ADR 0014). */
const SCOPE_TEXT: Record<string, string> = {
  "pipes:read": "See the open pipes of your orgs, as the wall shows them",
  "pipes:write": "Stop any of those pipes",
};

interface PublicClient {
  client_id: string;
  client_name?: string;
}

/** The site a client says it is, from its metadata document's URL: shown, never trusted. */
function clientHost(clientId: string) {
  return URL.canParse(clientId) ? new URL(clientId).host : null;
}

function toLogin() {
  location.assign(`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
}

/**
 * `/oauth/consent`, where the OAuth flow of the hosted MCP server (ADR 0014) asks a signed-in
 * person whether an assistant may reach their orgs' pipes. The query is Better Auth's, signed;
 * it goes back unchanged with the answer.
 */
function Review() {
  const search = new URLSearchParams(location.search);
  const clientId = search.get("client_id") ?? "";
  const scopes = (search.get("scope") ?? "").split(" ").filter((s) => s in SCOPE_TEXT);
  const review = useQuery({
    queryKey: ["consent", clientId],
    queryFn: async () => {
      const [client, me] = await Promise.all([
        api<PublicClient>(
          `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
        ),
        api<Me>("/api/me"),
      ]);
      return { client, orgs: me.orgs };
    },
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (accept: boolean) =>
      api<{ url: string }>("/api/auth/oauth2/consent", {
        method: "POST",
        body: { accept, oauth_query: location.search.slice(1) },
      }),
    onSuccess: ({ url }) => location.assign(url),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) toLogin();
    },
  });
  if (review.error instanceof ApiError && review.error.status === 401) {
    toLogin();
    return null;
  }
  if (review.isError) return <Text>{review.error.message}</Text>;

  return (
    <Skeleton
      id="oauth-consent"
      data={review.data}
      sample={{
        client: { client_id: "https://claude.ai/oauth/mcp-client", client_name: "Claude" },
        orgs: [{ id: "", name: "Handlemotion", role: "member", personal: false }],
      }}
      label="Loading the request"
    >
      {({ client, orgs }) => {
        const host = clientHost(client.client_id);
        return (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Heading>Connect {client.client_name ?? host ?? "this app"}?</Heading>
              <Text>
                {host ? (
                  <>
                    It says it is from <Strong>{host}</Strong>.{" "}
                  </>
                ) : null}
                It will be able to, in {orgs.map((o) => o.name).join(", ")}:
              </Text>
              {scopes.map((scope) => (
                <Text key={scope}>{SCOPE_TEXT[scope]}.</Text>
              ))}
              <Text>It cannot open pipes, see what passes through them, or manage your orgs.</Text>
            </div>
            <div className="flex flex-col gap-2">
              <Button
                size="lg"
                isPending={decide.isPending && decide.variables === true}
                isDisabled={decide.isPending}
                onPress={() => decide.mutate(true)}
              >
                Allow
              </Button>
              <Button
                intent="outline"
                size="lg"
                isPending={decide.isPending && decide.variables === false}
                isDisabled={decide.isPending}
                onPress={() => decide.mutate(false)}
              >
                Deny
              </Button>
            </div>
            {decide.error && !(decide.error instanceof ApiError && decide.error.status === 401) && (
              <Text className="text-danger-subtle-foreground">{decide.error.message}</Text>
            )}
          </div>
        );
      }}
    </Skeleton>
  );
}

export function Consent() {
  return (
    <SkeletonProvider>
      <main className="flex min-h-dvh items-center justify-center bg-surface px-4">
        <div className="flex w-full max-w-100 flex-col pb-12">
          <Card className="gap-6 p-6">
            <Review />
          </Card>
        </div>
      </main>
    </SkeletonProvider>
  );
}
