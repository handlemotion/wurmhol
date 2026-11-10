// The console's Domains dialog in a real browser (ADR 0030): shown only where the install has
// custom domains on, and it walks an owner from adding a hostname to seeing it active.
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeCloudflare, fakeResolver, TOKEN, ZONE } from "./domain-fakes.ts";
import { type Person, signIn, type Stack, startStack } from "./support.ts";

let stack: Stack;
let cloudflare: Awaited<ReturnType<typeof fakeCloudflare>>;
let resolver: Awaited<ReturnType<typeof fakeResolver>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let ada: Person;

beforeAll(async () => {
  cloudflare = await fakeCloudflare();
  resolver = await fakeResolver();
  stack = await startStack({
    CUSTOM_DOMAIN_TARGET: "domains.pipe.localhost",
    CLOUDFLARE_ZONE_ID: ZONE,
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_API_URL: cloudflare.url,
    DNS_RESOLVER_URL: resolver.url,
  });
  ada = await signIn(stack);
  browser = await chromium.launch();
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await context.addCookies(
    ada.cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return {
        name: pair.slice(0, at),
        value: pair.slice(at + 1),
        domain: "localhost",
        path: "/",
        secure: true,
        sameSite: "Lax" as const,
      };
    }),
  );
  page = await context.newPage();
  await page.goto(stack.url);
});

afterAll(async () => {
  await browser?.close();
  await stack.stop();
  await cloudflare.close();
  await resolver.close();
});

it("walks from adding a hostname to seeing it active", async () => {
  await page.getByRole("button", { name: "Domains" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Hostname").fill("preview.acme-ui.test");
  await dialog.getByLabel("Pipe name").fill("acme-ui");
  await dialog.getByRole("button", { name: "Add" }).click();

  // Both records are shown with what to publish, and the row says it is waiting on DNS.
  await expect.poll(() => dialog.getByText("Waiting for DNS").count()).toBe(1);
  await expect
    .poll(() => dialog.getByText("_wurmhol.preview.acme-ui.test").count())
    .toBeGreaterThan(0);
  await page.screenshot({
    path: process.env.DOMAINS_SHOTS ? `${process.env.DOMAINS_SHOTS}/pending.png` : undefined,
  });

  // The owner publishes both; Check now moves it to Active.
  const added = stack.db();
  try {
    const row = added
      .prepare("select challenge from custom_domains where hostname = ?")
      .get("preview.acme-ui.test") as { challenge: string };
    resolver.publish("_wurmhol.preview.acme-ui.test", `wurmhol-verify=${row.challenge}`);
  } finally {
    added.close();
  }
  cloudflare.set("preview.acme-ui.test", { status: "active", sslStatus: "active" });
  await dialog.getByRole("button", { name: "Check now" }).click();
  await expect.poll(() => dialog.getByText("Active", { exact: true }).count()).toBe(1);
  await page.screenshot({
    path: process.env.DOMAINS_SHOTS ? `${process.env.DOMAINS_SHOTS}/active.png` : undefined,
  });
});
