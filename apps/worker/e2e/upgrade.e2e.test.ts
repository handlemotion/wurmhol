// A Worker deploy keeps every Durable Object's storage: wall cards written by the previous
// Worker reach walls served by the new one, which must still get cards in the current shape.
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserSocket,
  cliEnv,
  createToken,
  localServer,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  waitFor,
} from "./support.ts";

/** Rewrites every stored wall card in `file` (an Org object's SQLite) through `change`. */
function rewriteCards(file: string, change: (card: Record<string, unknown>) => void) {
  const db = new DatabaseSync(file);
  try {
    const rows = db.prepare("select key, value from _cf_KV where key like 'share:%'").all() as {
      key: string;
      value: Uint8Array;
    }[];
    const update = db.prepare("update _cf_KV set value = ? where key = ?");
    for (const row of rows) {
      const card = deserialize(row.value) as Record<string, unknown>;
      change(card);
      update.run(serialize(card), row.key);
    }
    return rows.length;
  } finally {
    db.close();
  }
}

describe("wall cards stored by an older Worker", () => {
  let stack: Stack;
  let ada: Person;
  let env: Record<string, string>;

  beforeAll(async () => {
    stack = await startStack();
    ada = await signIn(stack);
    env = cliEnv(stack, (await createToken(stack, ada)).token);
  });
  afterAll(async () => {
    await stopAll(env);
    await stack.stop();
  });

  it("reach the wall with `views: []` when they have no view log", async () => {
    const local = await localServer((_req, res) => res.writeHead(200).end("ok"));
    const started = await share(stack, env, local.port);

    // The card as the Worker before the view log (ADR 0008) stored it: no `views`.
    let rewritten = 0;
    await stack.restart(() => {
      for (const file of stack.durableObjects("Org")) {
        rewritten += rewriteCards(file, (card) => delete card.views);
      }
    });
    expect(rewritten).toBe(1);

    const events: { type: string; shares?: { id: string; views?: unknown }[] }[] = [];
    const wall = browserSocket(`${stack.url}/api/live`, [], {
      cookie: ada.cookie,
      origin: stack.url,
    });
    wall.on("message", (data) => events.push(JSON.parse(data.toString())));
    const snapshot = await waitFor(() => events.find((e) => e.type === "snapshot"), {
      what: "the snapshot",
    });
    wall.close();
    await local.close();

    expect(snapshot.shares?.find((card) => card.id === started.id)?.views).toEqual([]);
  });
});
