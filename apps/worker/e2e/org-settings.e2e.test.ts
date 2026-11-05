// Org settings (spec section 3): rename, roles, handing ownership over, leaving and deleting,
// through the real organization plugin. An org never loses its last owner, members can't do owner
// things, nobody is left without an org, and a deleted org's pipes end.
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  api,
  browserFetch,
  cli,
  cliEnv,
  createToken,
  localServer,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  viewerCookie,
} from "./support.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack.stop();
});

interface MeBody {
  activeOrgId: string;
  role: string;
  orgs: { id: string; name: string; role: string }[];
}
const whoami = async (person: Person) => (await api<MeBody>(stack, person, "/api/me")).body;

/** `joiner` joins `owner`'s active org by invite link, and lands in it. */
async function join(owner: Person, joiner: Person) {
  const invite = await api<{ url: string }>(stack, owner, "/api/invites", { method: "POST" });
  const code = invite.body.url.split("/join/")[1]!;
  const accepted = await api(stack, joiner, `/api/invites/${code}/accept`, { method: "POST" });
  expect(accepted.status).toBe(200);
}

async function memberId(person: Person, of: Person) {
  const { body } = await api<{ members: { id: string; email: string }[] }>(
    stack,
    person,
    "/api/members",
  );
  return body.members.find((m) => m.email === of.email)!.id;
}

const setActive = (person: Person, organizationId: string) =>
  api(stack, person, "/api/auth/organization/set-active", {
    method: "POST",
    body: { organizationId },
  });

it("owners rename the org and change roles; members can't; the last owner can't step down", async () => {
  const ada = await signIn(stack);
  const bo = await signIn(stack);
  await join(ada, bo);
  const orgId = (await whoami(ada)).activeOrgId;
  const boId = await memberId(ada, bo);
  const adaId = await memberId(ada, ada);

  // A member: none of the owner's actions.
  expect((await api(stack, bo, "/api/org", { method: "PATCH", body: { name: "x" } })).status).toBe(
    403,
  );
  const boPromotes = await api(stack, bo, `/api/members/${boId}/role`, {
    method: "POST",
    body: { role: "owner" },
  });
  expect(boPromotes.status).toBe(403);
  expect((await api(stack, bo, "/api/org", { method: "DELETE" })).status).toBe(403);

  // The plugin's own routes are closed: they would skip these rules.
  for (const action of ["update", "update-member-role", "delete", "leave", "create"]) {
    const direct = await api(stack, ada, `/api/auth/organization/${action}`, {
      method: "POST",
      body: { organizationId: orgId, memberId: boId, role: "owner", data: { name: "x" } },
    });
    expect({ action, status: direct.status }).toEqual({ action, status: 404 });
  }

  const renamed = await api(stack, ada, "/api/org", { method: "PATCH", body: { name: "Acme" } });
  expect(renamed.status).toBe(200);
  expect((await whoami(bo)).orgs.find((o) => o.id === orgId)?.name).toBe("Acme");

  // Only our two roles.
  const admin = await api(stack, ada, `/api/members/${boId}/role`, {
    method: "POST",
    body: { role: "admin" },
  });
  expect(admin.status).toBe(400);

  // The last owner can't make themself a member.
  const stepDown = await api(stack, ada, `/api/members/${adaId}/role`, {
    method: "POST",
    body: { role: "member" },
  });
  expect(stepDown.status).toBe(409);

  // With a second owner, either may step down; then Bo, an owner, can rename.
  expect(
    (
      await api(stack, ada, `/api/members/${boId}/role`, {
        method: "POST",
        body: { role: "owner" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api(stack, ada, `/api/members/${adaId}/role`, {
        method: "POST",
        body: { role: "member" },
      })
    ).status,
  ).toBe(200);
  expect((await whoami(ada)).role).toBe("member");
  expect(
    (await api(stack, bo, "/api/org", { method: "PATCH", body: { name: "Bo's" } })).status,
  ).toBe(200);
  expect((await api(stack, ada, "/api/org", { method: "PATCH", body: { name: "x" } })).status).toBe(
    403,
  );
});

it("transferring ownership makes them the owner and you a member", async () => {
  const ada = await signIn(stack);
  const bo = await signIn(stack);
  await join(ada, bo);
  const boId = await memberId(ada, bo);

  const transferred = await api(stack, ada, `/api/members/${boId}/transfer`, { method: "POST" });
  expect(transferred.status).toBe(200);
  expect((await whoami(ada)).role).toBe("member");
  expect((await whoami(bo)).role).toBe("owner");
  // Ada can no longer do owner things.
  const back = await api(stack, ada, `/api/members/${await memberId(ada, ada)}/transfer`, {
    method: "POST",
  });
  expect(back.status).toBe(403);
});

it("members leave; the last owner and a person's only org can't be left", async () => {
  const ada = await signIn(stack);
  const bo = await signIn(stack);
  const cy = await signIn(stack);
  const orgId = (await whoami(ada)).activeOrgId;
  await join(ada, bo);
  // Ada is also in Cy's org, so leaving her own is refused for being its last owner alone.
  await join(cy, ada);
  expect((await setActive(ada, orgId)).status).toBe(200);

  const adaLeaves = await api<{ error: string }>(stack, ada, "/api/org/leave", { method: "POST" });
  expect(adaLeaves.status).toBe(409);
  expect(adaLeaves.body.error).toMatch(/only owner/i);

  const boLeaves = await api(stack, bo, "/api/org/leave", { method: "POST" });
  expect(boLeaves.status).toBe(200);
  const after = await whoami(bo);
  expect(after.orgs.map((o) => o.id)).not.toContain(orgId);
  // Back in the org Bo still has.
  expect(after.activeOrgId).toBe(after.orgs[0]!.id);

  // Bo's personal org is now Bo's only one.
  const onlyOrg = await api<{ error: string }>(stack, bo, "/api/org/leave", { method: "POST" });
  expect(onlyOrg.status).toBe(409);
  expect(onlyOrg.body.error).toMatch(/only org/);
  expect((await whoami(bo)).orgs).toHaveLength(1);
});

it("deleting an org ends its open pipes and its tokens; a person's only org can't be deleted", async () => {
  const ada = await signIn(stack);
  const bo = await signIn(stack);
  const adaOrg = (await whoami(ada)).activeOrgId;
  // Ada joins Bo's org, so her own is not her only one.
  await join(bo, ada);
  expect((await setActive(ada, adaOrg)).status).toBe(200);
  expect((await whoami(ada)).activeOrgId).toBe(adaOrg);

  const token = await createToken(stack, ada);
  const env = cliEnv(stack, token.token);
  const local = await localServer((_req, res) => res.end("still here"));
  const started = await share(stack, env, local.port);
  const cookie = await viewerCookie(stack, ada, started.url);
  expect(await (await browserFetch(`${started.url}/`, { cookie })).text()).toBe("still here");

  const deleted = await api(stack, ada, "/api/org", { method: "DELETE" });
  expect(deleted.status).toBe(200);

  const ended = await browserFetch(`${started.url}/`, { cookie });
  expect(ended.status).toBe(410);
  const after = await whoami(ada);
  expect(after.orgs.map((o) => o.id)).not.toContain(adaOrg);
  expect(after.activeOrgId).toBe(after.orgs[0]!.id);
  // The org's token went with it.
  const again = await cli([String(local.port)], env);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("Create a new token");
  const db = stack.db();
  try {
    expect(db.prepare("select count(*) as n from tokens where org_id = ?").get(adaOrg)).toEqual({
      n: 0,
    });
  } finally {
    db.close();
  }

  // Bo's org is Bo's only one; Ada is only a member of it.
  expect((await api(stack, ada, "/api/org", { method: "DELETE" })).status).toBe(403);
  expect((await api(stack, bo, "/api/org", { method: "DELETE" })).status).toBe(409);
  await stopAll(env);
  await local.close();
});
