// Better Auth's browser client: the same server as Omni's (packages/auth), on our own origin.
// Kept private to this module; the app calls the few functions below.
import { passkeyClient } from "@better-auth/passkey/client";
import { sameOriginPath } from "@wurmhol/protocol";
import { createAuthClient } from "better-auth/react";
import {
  magicLinkClient,
  multiSessionClient,
  organizationClient,
} from "better-auth/client/plugins";

const client = createAuthClient({
  plugins: [organizationClient(), passkeyClient(), multiSessionClient(), magicLinkClient()],
});

function check(result: { error: { message?: string } | null } | undefined, fallback: string) {
  if (result?.error) throw new Error(result.error.message ?? fallback);
}

export async function signInPasskey(): Promise<void> {
  check(await client.signIn.passkey(), "passkey sign-in failed");
}

export async function signInSocial(
  provider: "google" | "github",
  callbackURL: string,
): Promise<void> {
  check(
    await client.signIn.social({ provider, callbackURL, errorCallbackURL: "/login" }),
    "sign-in failed",
  );
}

export async function signInMagicLink(email: string, callbackURL: string): Promise<void> {
  check(await client.signIn.magicLink({ email, callbackURL }), "could not send the link");
}

export async function setActiveOrg(organizationId: string): Promise<void> {
  check(await client.organization.setActive({ organizationId }), "could not switch org");
}

export async function addPasskey(): Promise<void> {
  check(await client.passkey.addPasskey(), "could not add a passkey");
}

export async function signOut(): Promise<void> {
  await client.signOut();
}

/** A path in this app (`/join/x`, `/open?share=…`), never another site. */
export const safeNext = sameOriginPath;
