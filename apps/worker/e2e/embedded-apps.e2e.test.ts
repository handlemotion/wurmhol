// Embedded mode's applications and integration keys (ADR 0032, step 3), on the real stack with
// billing on. Only owners of a Business org manage them; a key is shown once and stored hashed;
// another org's application does not exist; and the routes are absent unless the install turns
// embedded mode on.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  me,
  type Person,
  signIn,
  type Stack,
  startPlan,
  startStack,
  STRIPE_E2E_VARS,
} from "./support.ts";

interface App {
  id: string;
  name: string;
  launchUrl: string | null;
  allowedOrigins: string[];
  tenantActiveTunnels: number | null;
}

let stack: Stack;
let owner: Person;
let orgId: string;

beforeAll(async () => {
  stack = await startStack({ ...STRIPE_E2E_VARS, EMBEDDED_ENABLED: "true" });
  owner = await signIn(stack);
  orgId = (await me(stack, owner)).activeOrgId;
});

afterAll(async () => {
  await stack.stop();
});

function createApp(person: Person, body: Record<string, unknown> = { name: "Dorks" }) {
  return api<{ app: App }>(stack, person, "/api/apps", { method: "POST", body });
}

async function joinAsMember(person: Person) {
  const invite = await api<{ url: string }>(stack, owner, "/api/invites", { method: "POST" });
  const code = invite.body.url.split("/join/")[1];
  const accepted = await api(stack, person, `/api/invites/${code}/accept`, { method: "POST" });
  expect(accepted.status).toBe(200);
}

describe("applications", () => {
  it("refuses an org with no plan, and a Friends org, with the fix", async () => {
    const none = await createApp(owner);
    expect(none.status).toBe(402);
    await startPlan(stack, orgId, "friends");
    const friends = await createApp(owner);
    expect(friends.status).toBe(402);
    expect(JSON.stringify(friends.body)).toContain("Business");
  });

  it("lets a Business org's owner create, change and list one", async () => {
    await startPlan(stack, orgId, "business", "customer.subscription.updated");
    const created = await createApp(owner, {
      name: "Dorks",
      launchUrl: "https://app.dorks.example/wurmhol/launch",
      allowedOrigins: ["https://app.dorks.example"],
      tenantActiveTunnels: 10,
    });
    expect(created.status).toBe(201);
    expect(created.body.app).toMatchObject({
      name: "Dorks",
      launchUrl: "https://app.dorks.example/wurmhol/launch",
      allowedOrigins: ["https://app.dorks.example"],
      tenantActiveTunnels: 10,
    });

    const changed = await api<{ app: App }>(stack, owner, `/api/apps/${created.body.app.id}`, {
      method: "PATCH",
      body: { name: "Dorks Desktop" },
    });
    expect(changed.body.app.name).toBe("Dorks Desktop");

    const listed = await api<{ apps: App[] }>(stack, owner, "/api/apps");
    expect(listed.body.apps.map((app) => app.name)).toContain("Dorks Desktop");
  });

  // Catches: a launch URL that sends users somewhere unencrypted or carries credentials, and an
  // origin with a path, which would never match a browser's Origin header.
  it.each([
    ["an http launch URL", { name: "x", launchUrl: "http://app.dorks.example/launch" }],
    ["credentials in the launch URL", { name: "x", launchUrl: "https://a:b@app.dorks.example/" }],
    ["an origin with a path", { name: "x", allowedOrigins: ["https://app.dorks.example/app"] }],
    ["a tenant default over the app's", { name: "x", activeTunnels: 5, tenantActiveTunnels: 6 }],
  ])("refuses %s", async (_label, body) => {
    expect((await createApp(owner, body)).status).toBe(400);
  });

  it("takes plain http only on localhost", async () => {
    const local = await createApp(owner, {
      name: "Local",
      launchUrl: "http://localhost:5173/launch",
      allowedOrigins: ["http://localhost:5173"],
    });
    expect(local.status).toBe(201);
  });

  it("refuses members who are not owners", async () => {
    const member = await signIn(stack);
    await joinAsMember(member);
    expect((await me(stack, member)).activeOrgId).toBe(orgId);
    expect((await api(stack, member, "/api/apps")).status).toBe(403);
    expect((await createApp(member)).status).toBe(403);
  });

  it("hides one org's application from another org's owner", async () => {
    const app = (await createApp(owner, { name: "Private" })).body.app;
    const stranger = await signIn(stack);
    await startPlan(stack, (await me(stack, stranger)).activeOrgId, "business");
    const theirs = await api<{ apps: App[] }>(stack, stranger, "/api/apps");
    expect(theirs.status).toBe(200);
    expect(theirs.body.apps).toEqual([]);
    expect((await api(stack, stranger, `/api/apps/${app.id}`)).status).toBe(404);
    const patch = { method: "PATCH", body: { name: "Mine now" } };
    expect((await api(stack, stranger, `/api/apps/${app.id}`, patch)).status).toBe(404);
    const keys = { method: "POST", body: { name: "k", permissions: ["grants:issue"] } };
    expect((await api(stack, stranger, `/api/apps/${app.id}/keys`, keys)).status).toBe(404);
    expect((await api(stack, stranger, `/api/apps/${app.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });
});

describe("integration keys", () => {
  let app: App;

  beforeAll(async () => {
    app = (await createApp(owner, { name: "Keys" })).body.app;
  });

  it("shows a key once, stores only its hash, and lists it without the secret", async () => {
    const made = await api<{ id: string; key: string; permissions: string[] }>(
      stack,
      owner,
      `/api/apps/${app.id}/keys`,
      { method: "POST", body: { name: "backend", permissions: ["grants:issue", "tunnels:read"] } },
    );
    expect(made.status).toBe(201);
    expect(made.body.key).toMatch(/^whk_[A-Za-z0-9_-]{43}$/);
    expect(made.body.permissions).toEqual(["tunnels:read", "grants:issue"]);

    const db = stack.db();
    try {
      const row = db.prepare("select hash from embed_app_keys where id = ?").get(made.body.id) as {
        hash: string;
      };
      expect(row.hash).toBe(createHash("sha256").update(made.body.key).digest("hex"));
      const anywhere = db
        .prepare("select count(*) as n from embed_app_keys where hash = ? or name = ?")
        .get(made.body.key, made.body.key) as { n: number };
      expect(anywhere.n).toBe(0);
    } finally {
      db.close();
    }

    const listed = await api<{ keys: Record<string, unknown>[] }>(
      stack,
      owner,
      `/api/apps/${app.id}/keys`,
    );
    expect(listed.body.keys).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.key);
    expect(listed.body.keys[0]).toMatchObject({ name: "backend" });
  });

  it.each([
    ["an unknown permission", ["tunnels:write"]],
    ["no permission", []],
  ])("refuses a key with %s", async (_label, permissions) => {
    const made = await api(stack, owner, `/api/apps/${app.id}/keys`, {
      method: "POST",
      body: { name: "bad", permissions },
    });
    expect(made.status).toBe(400);
  });

  it("revokes a key, and deleting the application revokes the rest", async () => {
    const make = () =>
      api<{ id: string }>(stack, owner, `/api/apps/${app.id}/keys`, {
        method: "POST",
        body: { name: "k", permissions: ["tunnels:read"] },
      });
    const first = (await make()).body.id;
    const second = (await make()).body.id;
    const revoke = await api(stack, owner, `/api/apps/${app.id}/keys/${first}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBe(200);
    const again = await api(stack, owner, `/api/apps/${app.id}/keys/${first}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);

    expect((await api(stack, owner, `/api/apps/${app.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(stack, owner, `/api/apps/${app.id}`)).status).toBe(404);
    const db = stack.db();
    try {
      const live = db
        .prepare("select count(*) as n from embed_app_keys where app_id = ? and revoked_at is null")
        .get(app.id) as { n: number };
      expect(live.n).toBe(0);
      expect(second).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe("with embedded mode off", () => {
  let off: Stack;

  beforeAll(async () => {
    off = await startStack();
  });

  afterAll(async () => {
    await off.stop();
  });

  it("has no application routes", async () => {
    const person = await signIn(off);
    expect((await api(off, person, "/api/apps")).status).toBe(404);
    const create = await api(off, person, "/api/apps", { method: "POST", body: { name: "x" } });
    expect(create.status).toBe(404);
  });
});
