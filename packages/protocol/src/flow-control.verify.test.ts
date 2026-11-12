// Exhaustive check of per-stream flow control (ADR 0002) on the real `SendWindow` and
// `ReceiveWindow`. One stream, one body direction: a sender that cuts its body into pieces and
// waits for credit before each, a FIFO socket each way, and a receiver that hands bytes on one
// piece at a time and sends back what `consumed` tells it to grant. Every interleaving of those
// steps, for every way of cutting the body, is explored up to the bounds below.
//
// Both directions run this same code: response bodies (packages/sdk/src/tunnel.ts #pumpResponse
// to apps/worker/src/share-do.ts #relay's pull) and request bodies (share-do.ts #pumpRequestBody
// to tunnel.ts's `data` handler). Window and piece sizes are scaled down; the precondition that
// links them to the real constants is checked against those constants below.
//
// Properties, for every reachable state:
// - no overrun: the receiver never throws "peer sent past its flow-control window";
// - bounded memory: bytes on the wire plus bytes waiting at the receiver never exceed the window;
// - credit adds up: the sender's credit is the window plus delivered grants minus bytes sent;
// - no stall: a state with no next step has the whole body handed on.
import { describe, expect, it } from "vitest";
import { MAX_CHUNK_BYTES } from "./frame.ts";
import { INITIAL_WINDOW, ReceiveWindow, SendWindow } from "./mux.ts";

interface Bounds {
  /** Initial window, in abstract units. */
  window: number;
  /** Largest piece the sender cuts (MAX_CHUNK_BYTES in the code). */
  piece: number;
  /** Body length. */
  body: number;
}

type Step =
  | { kind: "cut"; bytes: number }
  | { kind: "send" }
  | { kind: "deliver" }
  | { kind: "consume" }
  | { kind: "grant" };

/** The real windows plus everything around them that the code keeps in its own variables. */
interface World {
  send: SendWindow;
  receive: ReceiveWindow;
  cut: number;
  pending: number | null;
  /** The sender's `await send.ready(pending)`, started when the piece was cut and kept across
   * steps, so only the real `grant()` can wake it. */
  waiting: { resumed: boolean } | null;
  sent: number;
  toReceiver: number[];
  buffered: number[];
  toSender: number[];
  consumed: number;
  granted: number;
  grantsDelivered: number;
}

type Outcome = { ok: true; world: World } | { ok: false; violation: string };

function describeStep(step: Step, world: World): string {
  switch (step.kind) {
    case "cut":
      return `the sender cuts a ${step.bytes}-unit piece (chunk)`;
    case "send":
      return `the sender has credit ${world.send.available}, takes ${world.pending} and sends a data frame`;
    case "deliver":
      return `a ${world.toReceiver[0]}-unit data frame arrives and the receiver calls received()`;
    case "consume":
      return `the receiver hands on ${world.buffered[0]} units and calls consumed()`;
    case "grant":
      return `a window frame of ${world.toSender[0]} arrives and the sender calls grant()`;
  }
}

/** The head of a queue that `enabled` already saw was not empty. */
function take(queue: number[]): number {
  const head = queue.shift();
  if (head === undefined) throw new Error("stepped an empty queue");
  return head;
}

function apply(world: World, step: Step): string | null {
  switch (step.kind) {
    case "cut": {
      world.pending = step.bytes;
      world.cut += step.bytes;
      const waiting = { resumed: false };
      const { send } = world;
      void (async () => {
        await send.ready(step.bytes);
        waiting.resumed = true;
      })();
      world.waiting = waiting;
      return null;
    }
    case "send": {
      const bytes = world.pending ?? 0;
      try {
        world.send.take(bytes);
      } catch (error) {
        return `credit: ready() let the sender go, then take() refused: ${(error as Error).message}`;
      }
      world.sent += bytes;
      world.pending = null;
      world.waiting = null;
      world.toReceiver.push(bytes);
      return null;
    }
    case "deliver": {
      const bytes = take(world.toReceiver);
      try {
        world.receive.received(bytes);
      } catch (error) {
        return `overrun: ${(error as Error).message}`;
      }
      world.buffered.push(bytes);
      return null;
    }
    case "consume": {
      const bytes = take(world.buffered);
      world.consumed += bytes;
      const grant = world.receive.consumed(bytes);
      if (grant) {
        world.granted += grant;
        world.toSender.push(grant);
      }
      return null;
    }
    case "grant": {
      const bytes = take(world.toSender);
      world.send.grant(bytes);
      world.grantsDelivered += bytes;
      return null;
    }
  }
}

function enabled(world: World, bounds: Bounds): Step[] {
  const steps: Step[] = [];
  if (world.pending === null && world.cut < bounds.body) {
    for (let bytes = 1; bytes <= Math.min(bounds.piece, bounds.body - world.cut); bytes++) {
      steps.push({ kind: "cut", bytes });
    }
  }
  // The pumps `await stream.send.ready(piece.byteLength)` before every `take`.
  if (world.waiting?.resumed) steps.push({ kind: "send" });
  if (world.toReceiver.length) steps.push({ kind: "deliver" });
  if (world.buffered.length) steps.push({ kind: "consume" });
  if (world.toSender.length) steps.push({ kind: "grant" });
  return steps;
}

/** Lets a resolved `ready()` run on to the line after its `await`. */
async function settle() {
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
}

/** Replays `path` on fresh real windows, settling the sender's wait after each step that can
 * start or wake it, as the event loop would before the next frame arrives. */
async function replay(path: Step[], bounds: Bounds): Promise<Outcome> {
  const world: World = {
    send: new SendWindow(bounds.window),
    receive: new ReceiveWindow(bounds.window),
    cut: 0,
    pending: null,
    waiting: null,
    sent: 0,
    toReceiver: [],
    buffered: [],
    toSender: [],
    consumed: 0,
    granted: 0,
    grantsDelivered: 0,
  };
  for (const step of path) {
    const violation = apply(world, step);
    if (violation) return { ok: false, violation };
    if (step.kind === "cut" || step.kind === "grant") await settle();
  }
  return { ok: true, world };
}

function invariant(world: World, bounds: Bounds): string | null {
  const held = [...world.toReceiver, ...world.buffered].reduce((a, b) => a + b, 0);
  if (held > bounds.window) {
    return `memory: ${held} units on the wire or waiting at the receiver, window is ${bounds.window}`;
  }
  const credit = bounds.window + world.grantsDelivered - world.sent;
  if (world.send.available !== credit) {
    return `credit: sender has ${world.send.available}, window + grants - sent is ${credit}`;
  }
  return null;
}

function key(world: World): string {
  return [
    world.cut,
    world.pending,
    world.waiting?.resumed,
    world.sent,
    world.send.available,
    world.toReceiver.join("."),
    world.buffered.join("."),
    world.toSender.join("."),
    world.consumed,
    world.granted,
  ].join("|");
}

interface Report {
  states: number;
  counterexample: { violation: string; steps: string[] } | null;
}

/** Breadth-first over every interleaving; returns the shortest counterexample, if any. */
async function checkFlowControl(bounds: Bounds): Promise<Report> {
  const seen = new Set<string>();
  let frontier: Step[][] = [[]];
  const start = await replay([], bounds);
  if (start.ok) seen.add(key(start.world));

  const story = async (path: Step[]) => {
    const lines: string[] = [];
    for (const [i, step] of path.entries()) {
      const before = await replay(path.slice(0, i), bounds);
      lines.push(before.ok ? describeStep(step, before.world) : step.kind);
    }
    return lines;
  };

  while (frontier.length) {
    const next: Step[][] = [];
    for (const path of frontier) {
      const here = await replay(path, bounds);
      if (!here.ok) continue;
      const steps = enabled(here.world, bounds);
      if (!steps.length && here.world.consumed !== bounds.body) {
        return {
          states: seen.size,
          counterexample: {
            violation: `stall: ${here.world.consumed} of ${bounds.body} units handed on, the sender waits for ${here.world.pending} with credit ${here.world.send.available}, and nothing else can happen`,
            steps: await story(path),
          },
        };
      }
      for (const step of steps) {
        const child = [...path, step];
        const after = await replay(child, bounds);
        const violation = after.ok ? invariant(after.world, bounds) : after.violation;
        if (violation) {
          return { states: seen.size, counterexample: { violation, steps: await story(child) } };
        }
        if (!after.ok) continue;
        const k = key(after.world);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(child);
      }
    }
    frontier = next;
  }
  return { states: seen.size, counterexample: null };
}

/** The counterexample as numbered steps, for the failure message; null when the check holds. */
function told(report: Report): string | null {
  if (!report.counterexample) return null;
  const { violation, steps } = report.counterexample;
  return `${violation}\n${steps.map((step, i) => `  ${i + 1}. ${step}`).join("\n")}`;
}

describe("flow control, every interleaving", () => {
  it("the real constants keep a piece within half a window", () => {
    // The checks below assume it: a piece larger than half the window can wait forever for a
    // grant the receiver only sends after half a window (see the stall case at the end).
    expect(MAX_CHUNK_BYTES).toBeLessThanOrEqual(INITIAL_WINDOW / 2);
  });

  it("holds with pieces of up to half the window", async () => {
    const report = await checkFlowControl({ window: 8, piece: 4, body: 20 });
    expect(told(report)).toBeNull();
    expect(report.states).toBeGreaterThan(10_000);
  });

  it("holds over several grant cycles with small pieces", async () => {
    const report = await checkFlowControl({ window: 6, piece: 2, body: 24 });
    expect(told(report)).toBeNull();
    expect(report.states).toBeGreaterThan(10_000);
  });

  it("holds with odd window and piece sizes", async () => {
    const report = await checkFlowControl({ window: 7, piece: 3, body: 17 });
    expect(told(report)).toBeNull();
    expect(report.states).toBeGreaterThan(10_000);
  });

  it("finds the stall when a piece can be larger than half the window", async () => {
    // The checker's own failure case: proof that it can see a stall at all.
    const report = await checkFlowControl({ window: 8, piece: 6, body: 10 });
    expect(report.counterexample?.violation).toMatch(/^stall/);
  });
});
