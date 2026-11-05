import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { SkeletonProvider } from "@/components/ui/skeleton-provider";
import { Input } from "@/components/ui/input";
import { Code, Strong, Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { api, ApiError, type DeviceLogin } from "@/lib/api";

function toLogin() {
  location.assign(`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
}

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

/** `wurmhol login` (ADR 0008): approve or deny a computer's request for an org token. */
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
      if (error instanceof ApiError && error.status === 401) toLogin();
    },
  });
  if (login.error instanceof ApiError && login.error.status === 401) {
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
        status: "pending",
        org: { id: "", name: "Handlemotion" },
      }}
      label="Loading the login"
    >
      {(data) => (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Heading>Log in {data.name}?</Heading>
            <Text>
              It gets a token that opens pipes for <Strong>{data.org.name}</Strong>. Approve only if
              your terminal shows <Code className="tabular-nums">{data.code}</Code>.
            </Text>
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
          {decide.error && !(decide.error instanceof ApiError && decide.error.status === 401) && (
            <Text className="text-danger-subtle-foreground">{decide.error.message}</Text>
          )}
        </div>
      )}
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
