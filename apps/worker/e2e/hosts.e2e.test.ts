// The Worker's hosts (ADR 0006): the app (console, API, sign-in), an alias that redirects to it,
// the host the CLI dials (only /connect and /health), and pipes.
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  browserFetch,
  cli,
  cliEnv,
  connectProxy,
  createToken,
  localServer,
  parseJson,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
} from "./support.ts";

let stack: Stack;
let ada: Person;

beforeAll(async () => {
  stack = await startStack({ CONNECT_HOST: "api.localhost", APP_ALIASES: "app.localhost" });
  ada = await signIn(stack);
});

afterAll(async () => {
  await stack.stop();
});

it("an alias redirects permanently to the same path on the app", async () => {
  const response = await browserFetch(`http://app.localhost:${stack.port}/join/abc?x=1`);
  expect(response.status).toBe(301);
  expect(response.headers.get("location")).toBe(`${stack.url}/join/abc?x=1`);
});

it("the CLI's host answers /connect and /health, and nothing of the app", async () => {
  const api = `http://api.localhost:${stack.port}`;
  expect((await browserFetch(`${api}/health`)).status).toBe(200);

  for (const path of ["/", "/login", "/api/me", "/open?share=abcdefghij"]) {
    const response = await browserFetch(`${api}${path}`, { cookie: ada.cookie });
    expect(response.status).toBe(404);
  }
});

it("the CLI dials the host the console names, through a proxy, and opens a pipe on the pipe domain", async () => {
  const local = await localServer((_req, res) => res.end("through api"));
  const proxy = await connectProxy([stack.port]);
  // The Tokens dialog's WURMHOL_URL and host to allowlist are the ones the CLI dials.
  const { token, host, url: server } = await createToken(stack, ada);
  expect({ host, server }).toEqual({
    host: "api.localhost",
    server: `http://api.localhost:${stack.port}`,
  });

  const env = cliEnv(stack, token, {
    WURMHOL_URL: server ?? "",
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
  });

  const result = await cli([String(local.port), "--json"], env);
  expect(result.code).toBe(0);
  const { url, id } = parseJson(z.object({ url: z.string(), id: z.string() }), result.stdout);

  expect(url).toBe(stack.shareUrl(id));
  const cookie = await viewerCookie(stack, ada, url);
  expect(await (await browserFetch(`${url}/`, { cookie })).text()).toBe("through api");
  await stopAll(env);
  await proxy.close();
  await local.close();
});
