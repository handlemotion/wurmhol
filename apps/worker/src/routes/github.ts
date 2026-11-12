// `/api/github`: linking the org to a GitHub App installation, and the App's webhook (ADR 0016).
//
// Linking proves the person may see the installation: after GitHub's install page sends them to
// `/setup`, they authorize the App as themselves and `/callback` asks GitHub which installations
// that person can see. An installation id typed into a URL links nothing.
//
// The webhook is signed with GITHUB_APP_WEBHOOK_SECRET. A pull request opened for a branch with
// an open pipe posts that pipe to it; an uninstalled App is unlinked from every org.
import {
  linkInstallation,
  openSharesForBranch,
  orgInstallations,
  unlinkInstallation,
} from "@wurmhol/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { requireMember, requireOwner } from "../context.ts";
import type { GithubConfig } from "../env.ts";
import { github, readState, signState, verifyWebhook } from "../github.ts";
import { shareStub } from "../share-do.ts";

function githubConfig(c: { var: AppEnv["Variables"] }): GithubConfig {
  const config = c.var.config.github;

  if (!config) throw new HTTPException(404, { message: "GitHub is not set up on this install" });

  return config;
}

const callbackPath = "/api/github/callback";

/** The parts of a webhook delivery the App acts on: uninstalls and pull requests. */
const webhookPayload = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number() }).optional(),
  pull_request: z
    .object({
      head: z.object({
        ref: z.string(),
        repo: z.object({ full_name: z.string() }).nullable(),
      }),
    })
    .optional(),
});

/** The installations a person who authorized the App can see. */
const userInstallations = z.object({
  installations: z.array(z.object({ id: z.number(), account: z.object({ login: z.string() }) })),
});

/** GitHub's answer to the OAuth code exchange; no token when it refused. */
const codeExchange = z.object({ access_token: z.string().optional() });

export const githubRoutes = new Hono<AppEnv>()
  /** GitHub calls this; the signature is the authentication. */
  .post("/webhook", async (c) => {
    const config = githubConfig(c);
    const body = await c.req.text();

    if (!(await verifyWebhook(config.webhookSecret, body, c.req.header("x-hub-signature-256")))) {
      return c.json({ error: "bad signature" }, 401);
    }

    const event = c.req.header("x-github-event");

    const payload = webhookPayload.parse(JSON.parse(body));

    const installationId = payload.installation?.id;

    if (!installationId) return c.json({ ok: true });

    if (event === "installation" && payload.action === "deleted") {
      await unlinkInstallation(c.var.db, installationId);
      c.var.log.info("github.uninstalled", {});

      return c.json({ ok: true });
    }

    const head = payload.pull_request?.head;

    if (
      event === "pull_request" &&
      ["opened", "reopened", "ready_for_review"].includes(payload.action ?? "") &&
      head?.repo
    ) {
      const pipes = await openSharesForBranch(c.var.db, {
        installationId,
        repoHost: new URL(config.webUrl).host,
        repo: head.repo.full_name,
        branch: head.ref,
      });

      for (const pipe of pipes) {
        c.executionCtx.waitUntil(shareStub(c.env, pipe.id).preview());
      }

      c.var.log.info("github.pull_request", { pipes: pipes.length });
    }

    return c.json({ ok: true });
  })
  .use(requireMember)
  /** Whether GitHub is set up here, and the accounts the org has linked. */
  .get("/", async (c) => {
    const config = c.var.config.github;

    if (!config) return c.json({ available: false, installations: [] });
    const installations = await orgInstallations(c.var.db, c.var.member.orgId);

    return c.json({
      available: true,
      installations: installations.map(({ account }) => ({ account })),
    });
  })
  .use(requireOwner)
  /** Starts linking: GitHub's page to install the App, or pick an existing installation. */
  .get("/install", (c) => {
    const config = githubConfig(c);

    return c.redirect(`${config.webUrl}/apps/${config.slug}/installations/new`);
  })
  /** GitHub's Setup URL, after an install: ask the person to authorize, to prove who they are. */
  .get("/setup", async (c) => {
    const config = githubConfig(c);
    const installationId = Number(c.req.query("installation_id"));

    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      throw new HTTPException(400, { message: "no installation" });
    }

    const state = await signState(c.var.config.auth.secret, {
      orgId: c.var.member.orgId,
      userId: c.var.user.id,
      installationId,
    });

    const authorize = new URL(`${config.webUrl}/login/oauth/authorize`);
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set(
      "redirect_uri",
      new URL(callbackPath, c.var.config.auth.baseURL).toString(),
    );

    return c.redirect(authorize.toString());
  })
  /** Links the installation if GitHub shows it to the person who authorized. */
  .get("/callback", async (c) => {
    const config = githubConfig(c);
    const state = await readState(c.var.config.auth.secret, c.req.query("state"));

    if (!state || state.userId !== c.var.user.id || state.orgId !== c.var.member.orgId) {
      throw new HTTPException(400, { message: "this link has expired; connect GitHub again" });
    }

    const code = c.req.query("code");

    if (!code) throw new HTTPException(400, { message: "GitHub sent no code" });

    const exchanged = await fetch(`${config.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: new URL(callbackPath, c.var.config.auth.baseURL).toString(),
      }),
    });

    const { access_token: userToken } = codeExchange.parse(await exchanged.json());

    if (!userToken) throw new HTTPException(400, { message: "GitHub refused the authorization" });
    let found: { id: number; account: { login: string } } | undefined;

    for (let page = 1; page <= 10 && !found; page++) {
      const { installations } = await github(
        config,
        `Bearer ${userToken}`,
        "GET",
        `/user/installations?per_page=100&page=${page}`,
        userInstallations,
      );

      found = installations.find((installation) => installation.id === state.installationId);

      if (installations.length < 100) break;
    }

    if (!found) {
      throw new HTTPException(403, { message: "your GitHub account cannot see that installation" });
    }

    await linkInstallation(c.var.db, {
      orgId: state.orgId,
      installationId: found.id,
      account: found.account.login,
      linkedBy: state.userId,
    });
    c.var.log.info("github.linked", { orgId: state.orgId });

    return c.redirect("/");
  });
