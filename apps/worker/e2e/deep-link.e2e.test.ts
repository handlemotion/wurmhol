// `wurmhol <port> --path /page`: the link opens the pipe at that page, through sign-in, and a
// path that would leave the pipe is refused.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  browserFetch,
  cli,
  cliEnv,
  cliPath,
  cookiesOf,
  createToken,
  localServer,
  parseJson,
  type Person,
  signIn,
  type Stack,
  startStack,
  stopAll,
} from "./support.ts";

let stack: Stack;
let ada: Person;
let env: Record<string, string>;
let local: Awaited<ReturnType<typeof localServer>>;

const pageLink = z.object({ url: z.string(), pageUrl: z.string() });

beforeAll(async () => {
  stack = await startStack();
  ada = await signIn(stack);
  env = cliEnv(stack, (await createToken(stack, ada)).token);
  local = await localServer((req, res) =>
    res.writeHead(200, { "content-type": "text/plain" }).end(`page ${req.url}`),
  );
});

afterAll(async () => {
  await stopAll(env);
  await local.close();
  await stack.stop();
});

/** Opens `link` as a signed-out browser of `person` would: sign in, then follow back. */
async function open(link: string, person: Person) {
  const first = await browserFetch(link, {
    headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
  });

  const back = await browserFetch(first.headers.get("location")!, { cookie: person.cookie });
  const callback = await browserFetch(back.headers.get("location")!);
  const cookie = cookiesOf(callback).find((c) => c.startsWith("__Host-wurmhol="))!;
  const landing = new URL(callback.headers.get("location")!, link);
  const page = await browserFetch(landing.toString(), { cookie });

  return { landing: `${landing.pathname}${landing.search}`, body: await page.text() };
}

it("prints the pipe's URL at --path, and sign-in lands there", async () => {
  const json = await cli([String(local.port), "--path", "/checkout?step=2", "--json"], env);
  expect(json.code).toBe(0);
  const pipe = parseJson(pageLink, json.stdout);
  expect(pipe.pageUrl).toBe(`${pipe.url}/checkout?step=2`);
  // The plain form's first line is the link itself; a re-run with another page reuses the pipe.
  const plain = await cli([String(local.port), "--path", "/cart"], env);
  expect(plain.stdout.split("\n")[0]).toBe(`${pipe.url}/cart`);
  // Catches: the page lost on the way through sign-in, so the human lands on `/`.
  expect(await open(pipe.pageUrl, ada)).toEqual({
    landing: "/checkout?step=2",
    body: "page /checkout?step=2",
  });
  await stopAll(env);
});

it("refuses a --path that would leave the pipe, with a fix", async () => {
  for (const path of ["//evil.example/x", "https://evil.example/", "/\\evil.example", "checkout"]) {
    const run = await cli([String(local.port), "--path", path], env);
    // Catches: a link to another site printed as the pipe's.
    expect({ path, code: run.code }).toEqual({ path, code: 1 });
    expect(run.stderr).toContain("Use one like /checkout.");
  }

  expect((await cli(["ls", "--json"], env)).stdout).toBe("[]\n");
});

it("open_pipe takes a path and returns pageUrl", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stderr: "pipe",
  });

  const client = new Client({ name: "wurmhol-e2e", version: "0" });
  await client.connect(transport);

  try {
    const opened = z
      .object({ structuredContent: pageLink, content: z.array(z.object({ text: z.string() })) })
      .parse(
        await client.callTool({
          name: "open_pipe",
          arguments: { port: local.port, path: "/orders/7" },
        }),
      );

    expect(opened.structuredContent.pageUrl).toBe(`${opened.structuredContent.url}/orders/7`);
    expect(opened.content[0]!.text.split("\n")[0]).toBe(opened.structuredContent.pageUrl);

    const refused = z.object({ isError: z.boolean().optional() }).parse(
      await client.callTool({
        name: "open_pipe",
        arguments: { port: local.port, path: "//evil.example" },
      }),
    );

    expect(refused.isError).toBe(true);
  } finally {
    await client.close();
  }
});
