// A development stack opened through a pipe: it sends no mail, so the magic link comes back to
// the login page, on the origin the person asked from (the pipe), not on BETTER_AUTH_URL.
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import { browserFetch, cookiesOf, readJson, type Stack, startStack } from "./support.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({
    ENVIRONMENT: "development",
    // Any `*.localhost` stands in for the pipe hosts the stack is reached through.
    AUTH_TRUSTED_ORIGINS: "http://localhost:*,http://*.localhost:*",
  });
});

afterAll(async () => {
  await stack.stop();
});

it("returns the link on the origin the sign-in came from, and the link signs in there", async () => {
  // Catches: a link on BETTER_AUTH_URL (localhost), which a person behind a pipe can't open,
  // or one that signs them in on a host they aren't on.
  const elsewhere = `http://elsewhere.localhost:${stack.port}`;

  const sent = await browserFetch(`${stack.url}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: elsewhere },
    body: JSON.stringify({ email: "dev@example.com", callbackURL: `${elsewhere}/` }),
  });

  expect(sent.status).toBe(200);
  const { devLink } = await readJson(z.object({ devLink: z.string() }), sent);

  expect(new URL(devLink).origin).toBe(elsewhere);

  const verified = await browserFetch(devLink);
  expect(verified.headers.get("location")).toBe(`${elsewhere}/`);
  const cookie = cookiesOf(verified).join("; ");
  const me = await browserFetch(`${elsewhere}/api/me`, { cookie });
  expect((await me.json()).user.email).toBe("dev@example.com");
});
