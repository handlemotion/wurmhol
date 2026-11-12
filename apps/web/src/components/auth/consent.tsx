import { useMutation, useQuery } from "@tanstack/react-query";
import { Skeleton } from "skullet/react";
import { ConsentPlate } from "@/components/auth/consent-plate";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { IconCircleStop, IconCornerDownLeft, IconEye, IconUser } from "@/components/icons/lucide";
import { Text, TextLink } from "@/components/ui/text";
import { api, ApiError, type Me } from "@/lib/api";

/** Orgs as one phrase: "Handlemotion and your personal org". */
function orgList(orgs: Me["orgs"]) {
  const names = orgs.map((o) => (o.personal ? "your personal org" : o.name));

  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

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

type Glyph = React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/**
 * One line with a muted glyph before it. The glyph sits in a 20px box on the text's 20px line,
 * so its centre and the line's centre share an axis.
 */
function Row({ icon: Icon, children }: { icon: Glyph; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex h-5 shrink-0 items-center">
        <Icon aria-hidden className="size-icon text-muted-foreground" />
      </span>
      <Text className="leading-5">{children}</Text>
    </div>
  );
}

/**
 * A permission: its glyph on the title's line, the title in the foreground and, when there is
 * one, a muted line under it (20px lines, 2px apart), as on Google's and GitHub's consent screens.
 */
function Permission({
  icon: Icon,
  title,
  detail,
}: {
  icon: Glyph;
  title: string;
  detail?: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="flex h-5 shrink-0 items-center">
        <Icon aria-hidden className="size-icon text-muted-foreground" />
      </span>
      <div className="flex flex-col gap-0.5">
        <Text className="leading-5 text-foreground">{title}</Text>
        {detail && <Text className="leading-5">{detail}</Text>}
      </div>
    </li>
  );
}

/**
 * `/oauth/consent`, where the OAuth flow of the hosted MCP server (ADR 0014) asks a signed-in
 * person whether an assistant may reach their orgs' pipes. The query is Better Auth's, signed;
 * it goes back unchanged with the answer.
 */
function Review() {
  const search = new URLSearchParams(location.search);
  const clientId = search.get("client_id") ?? "";
  const scopes = new Set((search.get("scope") ?? "").split(" "));
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

      return { client, email: me.user.email, orgs: me.orgs };
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
        email: "ada@example.com",
        orgs: [{ id: "", name: "Handlemotion", role: "member", personal: false }],
      }}
      label="Loading the request"
    >
      {({ client, email, orgs }) => {
        const host = clientHost(client.client_id);
        const name = client.client_name ?? host ?? "This app";
        const reach = orgList(orgs);

        return (
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-2">
              <Heading size="sm">{name} wants to reach your pipes</Heading>
              <Row icon={IconUser}>
                {email} · <TextLink onPress={toLogin}>Not you?</TextLink>
              </Row>
            </div>
            <ul className="flex flex-col gap-4">
              {scopes.has("pipes:read") && (
                <Permission icon={IconEye} title="See your open pipes" detail={`In ${reach}`} />
              )}
              {scopes.has("pipes:write") && (
                <Permission icon={IconCircleStop} title="Stop any of them" />
              )}
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
              <Text className="leading-4 text-danger-subtle-foreground">
                {decide.error.message}
              </Text>
            )}
            {redirectHost && <Row icon={IconCornerDownLeft}>Sends you back to {redirectHost}</Row>}
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
