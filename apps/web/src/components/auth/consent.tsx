import { useMutation, useQuery } from "@tanstack/react-query";
import { Skeleton } from "skullet/react";
import { ConsentPlate } from "@/components/auth/consent-plate";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { IconCheck, IconX } from "@/components/icons/lucide";
import { Strong, Text, TextLink } from "@/components/ui/text";
import { api, ApiError, type Me } from "@/lib/api";

/** What each scope lets the assistant do (ADR 0014), one short line each. */
const SCOPE_TEXT: Record<string, string> = {
  "pipes:read": "See your open pipes",
  "pipes:write": "Stop any of them",
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
  /** Where the code goes, as the provider checked it against the client's registered URIs. */
  const redirect = search.get("redirect_uri") ?? "";
  const redirectHost = URL.canParse(redirect) ? new URL(redirect).host : null;
  const review = useQuery({
    queryKey: ["consent", clientId],
    queryFn: async () => {
      const [client, me] = await Promise.all([
        api<PublicClient>(
          `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
        ),
        api<Me>("/api/me"),
      ]);
      return { client, orgs: me.orgs, email: me.user.email };
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
        email: "ada@example.com",
      }}
      label="Loading the request"
    >
      {({ client, orgs, email }) => {
        const host = clientHost(client.client_id);
        const name = client.client_name ?? host ?? "This app";
        return (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Heading size="sm">{name} wants to reach your pipes</Heading>
              <Text>
                In {orgs.map((o) => (o.personal ? "your personal org" : o.name)).join(", ")}, as{" "}
                <Strong>{email}</Strong>. <TextLink onPress={toLogin}>Not you?</TextLink>
              </Text>
            </div>
            <ul className="flex flex-col gap-2">
              {scopes.map((scope) => (
                <li key={scope} className="flex items-center gap-2">
                  <IconCheck aria-hidden className="size-icon shrink-0 text-muted-foreground" />
                  <Text>{SCOPE_TEXT[scope]}</Text>
                </li>
              ))}
              <li className="flex items-center gap-2">
                <IconX aria-hidden className="size-icon shrink-0 text-muted-foreground" />
                <Text>Never open pipes or see what passes through them</Text>
              </li>
            </ul>
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
            <Text className="text-xs">
              {redirectHost ? (
                <>
                  Allowing sends you back to <Strong>{redirectHost}</Strong>.{" "}
                </>
              ) : null}
              {host ? `${name} says it is from ${host}; Wurmhol hasn't verified that.` : null}
            </Text>
          </div>
        );
      }}
    </Skeleton>
  );
}

/**
 * The page, laid out like the login: no card, the form in the hole of a construction drawing
 * (`ConsentPlate`, the `network-create` skill's `consent` scene). The drawing is anchored at the
 * centre of the form's column, at true size; its circle around the form is the person's orgs,
 * the small circle out to the right is the assistant, and the blue point where their two
 * tangents cross is the grant. Behind the content (`-z-10` inside the page's `isolate`), inked by
 * `text-hairline-line`.
 */
export function Consent() {
  return (
    <SkeletonProvider>
      <main className="relative isolate grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-12 lg:grid-cols-4 lg:justify-items-start lg:px-0">
        <div className="w-full max-w-88 lg:col-span-2 lg:col-start-2">
          <div className="relative">
            <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 -z-10 size-0">
              <ConsentPlate className="text-hairline-line" />
            </div>
            <Review />
          </div>
        </div>
      </main>
    </SkeletonProvider>
  );
}
