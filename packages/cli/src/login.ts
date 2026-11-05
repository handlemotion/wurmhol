// `wurmhol login`: the device-code flow (ADR 0008, RFC 8628). The CLI asks its server for a code,
// the human approves it in the console on any device, and the CLI polls until it gets an org
// token. Both calls go to the host the CLI already dials, through HTTPS_PROXY like the pipe.
// `wurmhol host --code` skips the approval: Create pipe hands it a code already approved by the
// signed-in member (ADR 0020), redeemed once on the same token endpoint.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { proxyFor, userAgent } from "./dial.ts";
import { explainConnectError, explainRefusal, FixError } from "./errors.ts";

interface Answer {
  status: number;
  body: string;
  viaProxy: boolean;
}

/** POSTs JSON to `path` on `server`, through the environment's proxy. */
function postJson(server: string, path: string, body: unknown, version: string): Promise<Answer> {
  const url = new URL(path, server);
  const { proxy, agent } = proxyFor(url);
  const send = url.protocol === "http:" ? httpRequest : httpsRequest;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "user-agent": userAgent(version),
        },
        agent,
        timeout: 15_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: text, viaProxy: Boolean(proxy) }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () =>
      req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
    );
    req.on("error", (error) => reject(explainConnectError(error, { server, proxy })));
    req.end(payload);
  });
}

function parse<T>(answer: Answer): T | null {
  try {
    return JSON.parse(answer.body) as T;
  } catch {
    return null;
  }
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface Granted {
  token: string;
  org: { id: string; name: string | null };
  name: string;
}

export interface LoginOptions {
  server: string;
  /** The computer's name: the token is named after it. */
  name: string;
  version: string;
  /** Prints the line that tells the human where to go. */
  prompt: (code: DeviceCode) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the flow to the end: the granted token, or a FixError that says what to do. */
export async function login(options: LoginOptions): Promise<Granted> {
  const { server, version } = options;
  const started = await postJson(server, "/device/code", { name: options.name }, version);
  const code = started.status === 200 ? parse<DeviceCode>(started) : null;
  if (!code?.device_code) {
    throw explainRefusal(started.status, started.body, { server, viaProxy: started.viaProxy });
  }
  options.prompt(code);
  let interval = Math.max(code.interval, 1) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const polled = await postJson(
      server,
      "/device/token",
      { device_code: code.device_code },
      version,
    );
    if (polled.status === 200) {
      const granted = parse<Granted>(polled);
      if (granted?.token) return granted;
    }
    const refused = parse<{ error?: string; fix?: string }>(polled);
    if (refused?.error === "authorization_pending") continue;
    // RFC 8628 section 3.5: poll five seconds slower from now on.
    if (refused?.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (polled.status === 429) {
      interval += 5000;
      continue;
    }
    if (refused?.fix) throw new FixError(refused.fix, { final: true });
    throw explainRefusal(polled.status, polled.body, { server, viaProxy: polled.viaProxy });
  }
  throw new FixError("The code expired before anyone approved it. Run wurmhol login again.");
}

export interface RedeemOptions {
  server: string;
  /** The setup code from Create pipe's command. */
  code: string;
  /** The computer's name: the token is named after it. */
  name: string;
  version: string;
}

/** What the CLI says when a setup code cannot be redeemed: get a fresh one. */
const STALE_CODE =
  "This setup code was already used or has expired. Copy the command again from Create pipe.";

/** Redeems a setup code: the granted token, or a FixError that says what to do. */
export async function redeem(options: RedeemOptions): Promise<Granted> {
  const { server, version } = options;
  const answer = await postJson(
    server,
    "/device/token",
    { device_code: options.code, name: options.name },
    version,
  );
  if (answer.status === 200) {
    const granted = parse<Granted>(answer);
    if (granted?.token) return granted;
  }
  const refused = parse<{ error?: string; fix?: string }>(answer);
  if (refused?.error === "invalid_grant" || refused?.error === "expired_token") {
    throw new FixError(STALE_CODE, { final: true });
  }
  if (refused?.fix) throw new FixError(refused.fix, { final: true });
  throw explainRefusal(answer.status, answer.body, { server, viaProxy: answer.viaProxy });
}
