import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { IconKey, IconMail } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { Wormhole } from "@/components/auth/wormhole";
import { useSignInMethods } from "@/hooks/use-app";
import { safeNext, signInMagicLink, signInPasskey, signInSocial } from "@/lib/auth";

const REASONS: Record<string, string> = {
  "not-member": "That pipe belongs to an org you're not in. Sign in with an account that is.",
};

/**
 * A brand mark drawn at 14px inside the 17px slot a `lg` button gives its icon, so the label
 * starts where it does after the passkey glyph. Full-colour marks carry more ink than a stroked
 * Lucide glyph, so the smaller size reads as the same weight.
 */
function ProviderMark({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-4.25 shrink-0 items-center justify-center *:size-3.5">
      {children}
    </span>
  );
}

/** The login page: passkeys, Google and GitHub (spec section 3). */
export function Login() {
  const params = new URLSearchParams(location.search);
  const next = safeNext(params.get("next"));
  const reason = REASONS[params.get("reason") ?? ""];
  const methods = useSignInMethods();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const callbackURL = new URL(next, location.origin).toString();

  const passkey = useMutation({
    mutationFn: async () => {
      await signInPasskey();
      location.assign(next);
    },
  });
  const social = useMutation({
    mutationFn: async (provider: "google" | "github") => {
      await signInSocial(provider, callbackURL);
    },
  });
  const magicLink = useMutation({
    mutationFn: async () => {
      await signInMagicLink(email, callbackURL);
      setSent(true);
    },
  });
  const failure = passkey.error ?? social.error ?? magicLink.error;

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-12">
      <Wormhole className="pointer-events-none absolute inset-0 -z-10 size-full text-foreground" />
      {/* The form sits raw on the canvas at the wormhole's centre, where the rings have faded out. */}
      <div className="flex w-full max-w-88 flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Heading>Welcome to the Wurmhol</Heading>
          <Text>{reason ?? "Sign in to see what your agents are building."}</Text>
        </div>
        <div className="flex flex-col gap-2">
          <Button
            intent="outline"
            size="lg"
            className="justify-start"
            isPending={passkey.isPending}
            onPress={() => passkey.mutate()}
          >
            <IconKey />
            Using a passkey
          </Button>
          {methods.data?.google && (
            <Button
              intent="outline"
              size="lg"
              className="justify-start"
              isPending={social.isPending && social.variables === "google"}
              onPress={() => social.mutate("google")}
            >
              <ProviderMark>
                <Google aria-hidden />
              </ProviderMark>
              Using Google
            </Button>
          )}
          {methods.data?.github && (
            <Button
              intent="outline"
              size="lg"
              className="justify-start"
              isPending={social.isPending && social.variables === "github"}
              onPress={() => social.mutate("github")}
            >
              <ProviderMark>
                <GitHubLight aria-hidden className="dark:hidden" />
                <GitHubDark aria-hidden className="hidden dark:block" />
              </ProviderMark>
              Using GitHub
            </Button>
          )}
        </div>
        {methods.data?.magicLink && <Separator label="or" />}
        {methods.data?.magicLink && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              magicLink.mutate();
            }}
          >
            <TextField
              type="email"
              aria-label="Email"
              autoComplete="username webauthn"
              isRequired
              value={email}
              onChange={setEmail}
            >
              <Input size="lg" placeholder="you@example.com" />
            </TextField>
            <Button type="submit" intent="secondary" size="lg" isPending={magicLink.isPending}>
              <IconMail />
              {sent ? "Check your email" : "Email me a link"}
            </Button>
          </form>
        )}
        {failure && <Text className="text-danger-subtle-foreground">{failure.message}</Text>}
      </div>
    </main>
  );
}
