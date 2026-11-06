import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { Input } from "@/components/ui/input";
import { Code, Strong, Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { useOpenBilling } from "@/hooks/use-app";
import { api, type DeviceLogin, isSignedOut, toLogin } from "@/lib/api";

/** How long the page waits for a pipe before it says where to look. */
const SLOW_PIPE_MS = 30_000;

/** No code in the link: type the one the terminal shows. */
function EnterCode() {
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        location.assign(`/device?code=${encodeURIComponent(code.trim())}`);
      }}
    >
      <div className="flex flex-col gap-2">
        <Heading>Log in a computer</Heading>
        <Text>Enter the code that wurmhol login shows in your terminal.</Text>
      </div>
      <div className="flex flex-col gap-2">
        <TextField aria-label="Code" isRequired value={code} onChange={setCode}>
          <Input size="lg" placeholder="ABCD-1234" autoComplete="off" className="tabular-nums" />
        </TextField>
        <Button type="submit" size="lg">
          Continue
        </Button>
      </div>
    </form>
  );
}

/**
 * After a share's login is approved (ADR 0026): waits for the computer to open its pipe, then
 * goes there. The page can't see why a pipe never comes (the computer only logs it), so after a
 * while it says where to look.
 */
function OpenPipe({ code, name, port }: { code: string; name: string | null; port: number }) {
  const pipe = useQuery({
    queryKey: ["device-pipe", code],
    queryFn: () => api<{ url: string | null }>(`/api/device/pipe?code=${encodeURIComponent(code)}`),
    refetchInterval: (query) => (query.state.data?.url ? false : 1000),
  });
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_PIPE_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (pipe.data?.url) location.replace(pipe.data.url);
  }, [pipe.data?.url]);
  return (
    <div className="flex flex-col gap-2">
      <Heading>Approved</Heading>
      <Text>
        {pipe.error
          ? pipe.error.message
          : `Port ${port} opens here as soon as ${name ?? "the computer"} connects.`}
      </Text>
      {slow && !pipe.data?.url && (
        <Text>
          Still waiting? Ask your agent to run <Code>npx wurmhol logs {port}</Code> and tell you
          what it says.
        </Text>
      )}
    </div>
  );
}

/**
 * A share's login for an org with no plan (ADR 0004): `/connect` would refuse the pipe, so the
 * page offers the fix in place of Approve. The code stays pending for the next visit.
 */
function NeedsPlan({ data }: { data: DeviceLogin }) {
  const billing = useOpenBilling();
  const owner = data.role === "owner";
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Heading>
          Open port {data.port} on {data.name}?
        </Heading>
        <Text>
          {owner ? (
            <>
              <Strong>{data.org.name}</Strong> has no plan yet, so the pipe can't open. Subscribe,
              then open this link again.
            </>
          ) : (
            <>
              Pipes open once an owner of <Strong>{data.org.name}</Strong> subscribes. Ask one, then
              open this link again.
            </>
          )}
        </Text>
      </div>
      {owner && (
        <Button size="lg" isPending={billing.isPending} onPress={() => billing.mutate()}>
          Subscribe
        </Button>
      )}
      {billing.error && !isSignedOut(billing.error) && (
        <Text className="text-danger-subtle-foreground">{billing.error.message}</Text>
      )}
    </div>
  );
}

/**
 * `wurmhol login` (ADR 0008), or `npx wurmhol <port>` with no token (ADR 0026): approve or deny
 * a computer's request for an org token.
 */
function Review({ code }: { code: string }) {
  const login = useQuery({
    queryKey: ["device", code],
    queryFn: () => api<DeviceLogin>(`/api/device?code=${encodeURIComponent(code)}`),
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      api(`/api/device/${decision}`, { method: "POST", body: { code } }),
    onError: (error) => {
      if (isSignedOut(error)) toLogin();
    },
  });
  if (isSignedOut(login.error)) {
    toLogin();
    return null;
  }

  if (login.isError) {
    return (
      <div className="flex flex-col gap-6">
        <Text>{login.error.message}</Text>
        <Button intent="outline" size="lg" onPress={() => location.assign("/device")}>
          Enter another code
        </Button>
      </div>
    );
  }
  if (decide.isSuccess && decide.variables === "approve" && login.data?.port) {
    return <OpenPipe code={code} name={login.data.name} port={login.data.port} />;
  }
  if (decide.isSuccess) {
    return (
      <div className="flex flex-col gap-2">
        <Heading>{decide.variables === "approve" ? "Approved" : "Denied"}</Heading>
        <Text>
          {decide.variables === "approve"
            ? "Go back to your terminal: wurmhol is logged in."
            : "That computer gets no token."}
        </Text>
      </div>
    );
  }
  return (
    <Skeleton
      id="device-login"
      data={login.data}
      sample={{
        code: "ABCD-1234",
        name: "ada-laptop",
        port: null,
        status: "pending",
        org: { id: "", name: "Handlemotion" },
        role: "owner",
        standing: { ok: true, reason: "subscribed" },
      }}
      label="Loading the login"
    >
      {(data) =>
        data.port && data.status === "pending" && !data.standing.ok ? (
          <NeedsPlan data={data} />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              {data.port ? (
                <>
                  <Heading>
                    Open port {data.port} on {data.name}?
                  </Heading>
                  <Text>
                    It gets a token that opens pipes for <Strong>{data.org.name}</Strong>, and this
                    page opens the pipe. Approve only a link you expected from your agent.
                  </Text>
                </>
              ) : (
                <>
                  <Heading>Log in {data.name}?</Heading>
                  <Text>
                    It gets a token that opens pipes for <Strong>{data.org.name}</Strong>. Approve
                    only if your terminal shows <Code className="tabular-nums">{data.code}</Code>.
                  </Text>
                </>
              )}
            </div>
            {data.status === "pending" ? (
              <div className="flex flex-col gap-2">
                <Button
                  size="lg"
                  isPending={decide.isPending && decide.variables === "approve"}
                  isDisabled={decide.isPending}
                  onPress={() => decide.mutate("approve")}
                >
                  Approve
                </Button>
                <Button
                  intent="outline"
                  size="lg"
                  isPending={decide.isPending && decide.variables === "deny"}
                  isDisabled={decide.isPending}
                  onPress={() => decide.mutate("deny")}
                >
                  Deny
                </Button>
              </div>
            ) : (
              <Text>This code was already used.</Text>
            )}
            {decide.error && !isSignedOut(decide.error) && (
              <Text className="text-danger-subtle-foreground">{decide.error.message}</Text>
            )}
          </div>
        )
      }
    </Skeleton>
  );
}

/** `/device` and `/device?code=ABCD-1234`, where `wurmhol login` sends people. */
export function Device() {
  const code = new URLSearchParams(location.search).get("code")?.trim();
  return (
    <SkeletonProvider>
      <main className="flex min-h-dvh items-center justify-center bg-surface px-4">
        <div className="flex w-full max-w-100 flex-col pb-12">
          <Card className="gap-6 p-6">{code ? <Review code={code} /> : <EnterCode />}</Card>
        </div>
      </main>
    </SkeletonProvider>
  );
}
