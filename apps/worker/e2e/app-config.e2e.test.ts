// The config the Worker hands the web app: a self-hosted install's DOCS_URL reaches the page.
import { afterAll, beforeAll, expect, it } from "vitest";
import { browserFetch, type Stack, startStack } from "./support.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ DOCS_URL: "https://docs.example.test/wurmhol" });
});

afterAll(async () => {
  await stack.stop();
});

it("serves pages with the configured docs URL inline, and the same from /api/app-config", async () => {
  const page = await (await browserFetch(`${stack.url}/`)).text();
  const inline = /<script id="app-config" type="application\/json">(.+?)<\/script>/.exec(page);
  // Catches: the wall linking to the hosted docs whatever a self-hoster sets.
  expect(inline, "the page carries no app config").not.toBeNull();
  expect(JSON.parse(inline![1]!)).toEqual({
    docsUrl: "https://docs.example.test/wurmhol",
    customDomains: false,
  });
  // Catches: the Vite dev server (no inline config) getting a different answer.
  const api = await (await browserFetch(`${stack.url}/api/app-config`)).json();
  expect(api).toEqual({
    docsUrl: "https://docs.example.test/wurmhol",
    customDomains: false,
  });
});
