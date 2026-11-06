// `wurmhol login`: the device-code flow (ADR 0008, RFC 8628). The CLI asks its server for a code,
// the human approves it in the console on any device, and the CLI polls until it gets an org
// token. Both calls go to the host the CLI already dials, through HTTPS_PROXY like the pipe.
// `wurmhol host --code` skips the approval: Create pipe hands it a code already approved by the
// signed-in member (ADR 0020), redeemed once on the same token endpoint. `wurmhol <port>` with no
// token starts a code with its port and leaves the waiting to its daemon (ADR 0026).
import { type Answer, send } from "./dial.ts";
import { explainRefusal, FixError } from "./errors.ts";

/** POSTs JSON to `path` on `server`, through the environment's proxy. */
function postJson(server: string, path: string, body: unknown, version: string): Promise<Answer> {
  return send(new URL(path, server), { server, version, method: "POST", json: body });
}

function parse<T>(answer: Answer): T | null {
  try {
    return JSON.parse(answer.body) as T;
  } catch {
    return null;
  }
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface Granted {
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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Asks for a code; `port` makes it a share's login, whose approval page opens that pipe. */
export async function startLogin(options: {
  server: string;
  name: string;
  version: string;
  port?: number;
}): Promise<DeviceCode> {
  const { server, version, name, port } = options;
  const started = await postJson(server, "/device/code", { name, port }, version);
  const code = started.status === 200 ? parse<DeviceCode>(started) : null;
  if (!code?.device_code) {
    throw explainRefusal(started.status, started.body, { server, viaProxy: started.viaProxy });
  }
  return code;
}

/** Runs the flow to the end: the granted token, or a FixError that says what to do. */
export async function login(options: LoginOptions): Promise<Granted> {
  const code = await startLogin(options);
  options.prompt(code);
  return awaitLogin({ server: options.server, version: options.version, code });
}

/**
 * Polls until someone approves `code`: the granted token, or a FixError that says what to do.
 * `signal` ends the wait early with its reason.
 */
export async function awaitLogin(options: {
  server: string;
  version: string;
  code: DeviceCode;
  signal?: AbortSignal;
}): Promise<Granted> {
  const { server, version, code, signal } = options;
  let interval = Math.max(code.interval, 1) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval, signal);
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
