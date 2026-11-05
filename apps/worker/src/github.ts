// A pipe as a GitHub Deployment on its pull request (ADR 0016). When an open pipe's repo and
// branch match an open pull request in a repo the org's GitHub App installation covers, the pipe
// URL is posted there as a deployment to `wurmhol-preview` (state success, environment_url the
// pipe), and marked inactive when the pipe ends. Without a GitHub App configured, or with no
// installation linked, nothing here runs.
import { orgInstallations, type Db } from "@wurmhol/db";
import type { PipeSource } from "@wurmhol/protocol";
import githubAppJwt from "universal-github-app-jwt";
import type { GithubConfig } from "./env.ts";

export const DEPLOYMENT_ENVIRONMENT = "wurmhol-preview";

/** A deployment the pipe posted, enough to mark it inactive at the end. */
export interface Preview {
  installationId: number;
  /** `owner/name`, as GitHub spells it. */
  repo: string;
  deploymentId: number;
  pullRequest: number;
  pullRequestUrl: string;
}

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One GitHub REST call. Bodies of errors are not kept: they can echo what we sent. */
export async function github<T>(
  config: GithubConfig,
  auth: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: auth,
      "user-agent": "wurmhol",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GithubError(
      response.status,
      `GitHub ${method} ${path.split("?")[0]}: ${response.status}`,
    );
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

/** DER length: short form under 128, else 0x80 | byte count, then the bytes. */
function derLength(length: number) {
  if (length < 128) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * The App's key as PKCS#8. GitHub downloads keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`) and Web
 * Crypto imports only PKCS#8, which is the same key in a fixed envelope:
 * SEQUENCE { INTEGER 0, SEQUENCE { rsaEncryption, NULL }, OCTET STRING { the PKCS#1 key } }.
 */
export function pkcs8(pem: string) {
  const match = /-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/.exec(pem);
  if (!match) return pem;
  const pkcs1 = Uint8Array.from(atob(match[1]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const rsaAlgorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const octets = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [0x02, 0x01, 0x00, ...rsaAlgorithm, ...octets];
  const der = Uint8Array.from([0x30, ...derLength(body.length), ...body]);
  const base64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

/** A token for one installation, good for an hour; minted per use. */
async function installationToken(config: GithubConfig, installationId: number) {
  const { token } = await githubAppJwt({ id: config.appId, privateKey: pkcs8(config.privateKey) });
  const minted = await github<{ token: string }>(
    config,
    `Bearer ${token}`,
    "POST",
    `/app/installations/${installationId}/access_tokens`,
  );
  return `token ${minted.token}`;
}

/** Whether a pipe's source is a branch of a repo on this GitHub. */
function onGithub(
  config: GithubConfig,
  source: PipeSource | null,
): source is PipeSource & { repo: string; branch: string } {
  return Boolean(source?.repo && source.branch && source.repoHost === new URL(config.webUrl).host);
}

interface PullRequest {
  number: number;
  html_url: string;
  head: { sha: string };
  base: { repo: { full_name: string } };
}

/**
 * Posts `pipeUrl` as a deployment on the open pull request of the pipe's branch, through the
 * org's installation on the repo's owner. Null when there is no such installation or pull request.
 */
export async function postPreview(
  config: GithubConfig,
  db: Db,
  pipe: { id: string; orgId: string; url: string; source: PipeSource | null },
): Promise<Preview | null> {
  const { source } = pipe;
  if (!onGithub(config, source)) return null;
  const owner = source.repo.split("/")[0]!.toLowerCase();
  const installation = (await orgInstallations(db, pipe.orgId)).find(
    (row) => row.account.toLowerCase() === owner,
  );
  if (!installation) return null;
  const auth = await installationToken(config, installation.installationId);
  const head = encodeURIComponent(`${owner}:${source.branch}`);
  const [pull] = await github<PullRequest[]>(
    config,
    auth,
    "GET",
    `/repos/${source.repo}/pulls?state=open&head=${head}&per_page=1`,
  );
  if (!pull) return null;
  const repo = pull.base.repo.full_name;
  const deployment = await github<{ id: number }>(
    config,
    auth,
    "POST",
    `/repos/${repo}/deployments`,
    {
      ref: pull.head.sha,
      environment: DEPLOYMENT_ENVIRONMENT,
      description: `Wurmhol pipe ${pipe.id}`,
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
      production_environment: false,
      payload: { pipe: pipe.id },
    },
  );
  await github(config, auth, "POST", `/repos/${repo}/deployments/${deployment.id}/statuses`, {
    state: "success",
    environment_url: pipe.url,
    description: "Pipe open",
    // Several pipes of one repo can be open at once; each is retired when its pipe ends.
    auto_inactive: false,
  });
  return {
    installationId: installation.installationId,
    repo,
    deploymentId: deployment.id,
    pullRequest: pull.number,
    pullRequestUrl: pull.html_url,
  };
}

/** Marks a pipe's deployment inactive: the pipe ended. */
export async function retirePreview(config: GithubConfig, preview: Preview) {
  const auth = await installationToken(config, preview.installationId);
  await github(
    config,
    auth,
    "POST",
    `/repos/${preview.repo}/deployments/${preview.deploymentId}/statuses`,
    { state: "inactive", description: "Pipe ended" },
  );
}

const encoder = new TextEncoder();

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether `signature` (`sha256=<hex>`, GitHub's `X-Hub-Signature-256`) signs `body`. */
export async function verifyWebhook(secret: string, body: string, signature: string | undefined) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = encoder.encode(`sha256=${hex(await hmac(secret, body))}`);
  const given = encoder.encode(signature);
  return expected.byteLength === given.byteLength && crypto.subtle.timingSafeEqual(expected, given);
}

/** A signed, expiring state for the link flow: who asked, for which org and installation. */
export async function signState(
  secret: string,
  state: { orgId: string; userId: string; installationId: number },
) {
  const body = btoa(JSON.stringify({ ...state, exp: Date.now() + 10 * 60_000 }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${body}.${hex(await hmac(`github-link:${secret}`, body))}`;
}

export async function readState(
  secret: string,
  value: string | undefined,
): Promise<{ orgId: string; userId: string; installationId: number } | null> {
  const [body, mac] = (value ?? "").split(".");
  if (!body || !mac) return null;
  const expected = encoder.encode(hex(await hmac(`github-link:${secret}`, body)));
  const given = encoder.encode(mac);
  if (expected.byteLength !== given.byteLength || !crypto.subtle.timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    const state = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof state.exp === "number" && state.exp > Date.now() ? state : null;
  } catch {
    return null;
  }
}
