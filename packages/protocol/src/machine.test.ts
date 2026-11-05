import { expect, it } from "vitest";
import { MACHINE_LIMITS, parseHostMessage, parseRelayMessage } from "./machine.ts";

// Catches: the CLI sending a shape the relay drops, so the wall never sees its ports or answers.
it("accepts what wurmhol host sends", () => {
  const ports = {
    type: "ports",
    ports: [
      { port: 5173, title: "Vite" },
      { port: 3000, title: null },
    ],
  };
  expect(parseHostMessage(ports)).toEqual(ports);
  const opened = { type: "opened", id: "a", url: "https://abcdefghij.wurmhol.dev/" };
  expect(parseHostMessage(opened)).toEqual(opened);
  const failed = { type: "failed", id: "a", message: "x".repeat(MACHINE_LIMITS.message) };
  expect(parseHostMessage(failed)).toEqual(failed);
});

it.each([
  // Catches: a machine filling the Org object's memory, which keeps every port on the socket.
  [
    "too many ports",
    { type: "ports", ports: Array.from({ length: 65 }, (_, i) => ({ port: i + 1, title: null })) },
  ],
  ["a port out of range", { type: "ports", ports: [{ port: 70_000, title: null }] }],
  ["a long title", { type: "ports", ports: [{ port: 3000, title: "x".repeat(201) }] }],
  // Catches: a URL the wall would render as a script link.
  ["a javascript: URL", { type: "opened", id: "a", url: "javascript:alert(1)" }],
  ["a long failure", { type: "failed", id: "a", message: "x".repeat(501) }],
  ["an unknown type", { type: "open", id: "a", port: 3000 }],
])("refuses %s from a machine", (_label, message) => {
  expect(parseHostMessage(message)).toBeNull();
});

// Catches: the CLI opening a pipe to a port the relay never asked for.
it("reads only a well-formed open from the relay", () => {
  expect(parseRelayMessage({ type: "open", id: "a", port: 5173 })).toEqual({
    type: "open",
    id: "a",
    port: 5173,
  });
  expect(parseRelayMessage({ type: "open", id: "a", port: 0 })).toBeNull();
  expect(parseRelayMessage({ type: "open", id: "a", port: "5173" })).toBeNull();
});
