// `wurmhol doctor` against the real stack: the built CLI checks its token on the CLI's host, the
// hosts through a real CONNECT proxy like a sandbox's, and a real local port.
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  api,
  cli,
  cliEnv,
  connectProxy,
  createToken,
  localServer,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
} from "./support.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix: string | null;
}

let stack: Stack;
let ada: Person;
let proxy: Awaited<ReturnType<typeof connectProxy>>;
/** What the Tokens dialog names as WURMHOL_URL: the CLI's own host. */
let server: string;

beforeAll(async () => {
  stack = await startStack({ CONNECT_HOST: "api.localhost" });
  ada = await signIn(stack);
  proxy = await connectProxy([stack.port]);
  server = `http://api.localhost:${stack.port}`;
});

afterAll(async () => {
  await proxy.close();
  await stack.stop();
});

/** A sandbox's environment: the CLI's host, through the proxy. */
function sandbox(token: string, viaProxy = proxy.url) {
  return cliEnv(stack, token, { WURMHOL_URL: server, HTTPS_PROXY: viaProxy, HTTP_PROXY: viaProxy });
}

async function doctor(env: Record<string, string>, args: string[] = []) {
  const result = await cli(["doctor", "--json", ...args], env);
  expect(result.stderr).toBe("");
  const { checks } = JSON.parse(result.stdout) as { checks: Check[] };
  return { code: result.code, checks: Object.fromEntries(checks.map((c) => [c.name, c])) };
}

// Catches doctor failing a working sandbox: a valid pipes-only token read as invalid (the route
// refuses it for scope), the pipe domain not taken from an open pipe, or a check that cannot pass.
it("passes every check with a good token of either scope, and names the pipe domain", async () => {
  const local = await localServer((_req, res) => res.end("ok"));
  for (const scope of ["org", "pipes"] as const) {
    const { token } = await createToken(stack, ada, `doctor-${scope}`, { scope });
    const env = sandbox(token);
    await share(stack, env, local.port);
    const { code, checks } = await doctor(env, ["--port", String(local.port)]);
    expect(Object.values(checks).filter((c) => !c.ok)).toEqual([]);
    expect(code).toBe(0);
    expect(checks["pipe-domain"]?.detail).toBe("*.pipe.localhost answers");
    expect(checks.proxy?.detail).toBe(`through ${proxy.url}`);
    await stopAll(env);
  }
  await local.close();
});

// Catches an unknown or revoked token passing because the server answered at all, and the fix
// being anything but the server's own one line.
it("an unknown or revoked token gives the token fix and exits 1", async () => {
  const revoked = await createToken(stack, ada, "doctor-revoked");
  expect((await api(stack, ada, `/api/tokens/${revoked.id}`, { method: "DELETE" })).status).toBe(
    200,
  );
  for (const token of [revoked.token, `wh_${"x".repeat(43)}`]) {
    const { code, checks } = await doctor(sandbox(token));
    expect(code).toBe(1);
    expect(checks.token).toMatchObject({ ok: false, detail: "refused (HTTP 401)" });
    expect(checks.token?.fix).toBe(
      `Create a new token at ${stack.url} (menu → Tokens) and set WURMHOL_TOKEN.`,
    );
    expect(checks["api-host"]?.ok).toBe(true);
  }
});

// Catches a refusing proxy read as a dead server or a bad token, or the fix naming a host other
// than the one the CLI dials.
it("a proxy that refuses the API host names the host to allowlist", async () => {
  const refusing = await connectProxy([]);
  const { token } = await createToken(stack, ada, "doctor-refused");
  const env = sandbox(token, refusing.url);
  const { code, checks } = await doctor(env);
  expect(code).toBe(1);
  const allowlist =
    "The network proxy refused the connection (HTTP 403). Allowlist api.localhost in the sandbox's network settings.";
  expect(checks["api-host"]).toMatchObject({ ok: false, fix: allowlist });
  expect(checks.token).toMatchObject({ ok: false, fix: allowlist });
  // The text form is one line per check, the fix on the failing ones.
  const text = await cli(["doctor"], env);
  expect(text.stdout).toContain(`fix  api-host: ${allowlist}\n`);
  await refusing.close();
});

// Catches a dead port reported as fine (or crashing the CLI where ::1 cannot exist), and a live
// one on 127.0.0.1 reported as dead.
it("--port tells a listening port from one nothing listens on", async () => {
  const { token } = await createToken(stack, ada, "doctor-port");
  const env = sandbox(token);
  const local = await localServer((_req, res) => res.writeHead(404).end());
  const listening = await doctor(env, ["--port", String(local.port)]);
  expect(listening.code).toBe(0);
  expect(listening.checks.port?.detail).toMatch(
    new RegExp(`^${local.port} answers HTTP on 127\\.0\\.0\\.1`),
  );
  await local.close();
  const silent = await doctor(env, ["--port", String(local.port)]);
  expect(silent.code).toBe(1);
  expect(silent.checks.port).toMatchObject({ ok: false });
  expect(silent.checks.port?.fix).toMatch(
    new RegExp(`^Nothing answers HTTP on port ${local.port}\\b.*Start the dev server`),
  );
});
