// Magic-link sign-in through Cloudflare Email Service (ADR 0005). wrangler dev simulates the
// `send_email` binding: each email's text lands in a file whose path it logs, so this signs in
// from the email itself, the way a person would.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { browserFetch, cookiesOf, type Stack, startStack, waitFor } from "./support.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({
    MAIL_FROM: "sign-in@wurmhol.test",
    RATE_LIMIT_AUTH: "off",
    RATE_LIMIT_MAGIC_LINK: "2/900",
  });
});

afterAll(async () => {
  await stack.stop();
});

function requestLink(email: string) {
  return browserFetch(`${stack.url}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: stack.url },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
}

/** The text of every email the simulated binding sent so far. */
function sentEmails() {
  return [...stack.output().matchAll(/^Text: (.+\.txt)$/gm)].map((m) =>
    readFileSync(m[1]!, "utf8"),
  );
}

it("emails a link that signs the person in", async () => {
  expect((await (await browserFetch(`${stack.url}/api/sign-in-methods`)).json()).magicLink).toBe(
    true,
  );
  const before = sentEmails().length;
  const sent = await requestLink("ada@example.com");
  expect(sent.status).toBe(200);
  // Catches: the development-only link leaking into a response outside development.
  expect(await sent.json()).toEqual({ status: true });
  const email = await waitFor(() => sentEmails()[before], { what: "the email" });
  expect(email).toContain("Open this link to sign in to Wurmhol");
  const link = /(http:\/\/\S+magic-link\/verify\S+)/.exec(email)![1]!;
  const verified = await browserFetch(link);
  const cookie = cookiesOf(verified).join("; ");
  const me = await browserFetch(`${stack.url}/api/me`, { cookie });
  expect(me.status).toBe(200);
  expect((await me.json()).user.email).toBe("ada@example.com");
});

it("serves the login page with its sign-in methods inline, so the buttons paint at once", async () => {
  const api = await (await browserFetch(`${stack.url}/api/sign-in-methods`)).json();
  const page = await (await browserFetch(`${stack.url}/login`)).text();
  const inline = /<script id="sign-in-methods" type="application\/json">(.+?)<\/script>/.exec(page);
  expect(inline, "the page carries no sign-in methods").not.toBeNull();
  expect(JSON.parse(inline![1]!)).toEqual(api);
});

it("limits links per address, so nobody mail-bombs an inbox through us", async () => {
  expect((await requestLink("bob@example.com")).status).toBe(200);
  expect((await requestLink("Bob@Example.com")).status).toBe(200);
  const third = await requestLink("bob@example.com");
  expect(third.status).toBe(429);
  expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  // Another address is unaffected.
  expect((await requestLink("cleo@example.com")).status).toBe(200);
});
