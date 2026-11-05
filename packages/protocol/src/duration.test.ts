import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  it.each([
    ["90m", 5400],
    ["8h", 28_800],
    ["1h30m", 5400],
    ["45s", 45],
    ["2H", 7200],
  ])("reads %s", (text, seconds) => {
    expect(parseDuration(text)).toBe(seconds);
  });

  it.each([
    // Catches: a bare number read as seconds when the user meant minutes or hours, a fraction
    // truncated to a much shorter pipe, and an empty or zero lifetime that ends the pipe at once.
    "90",
    "1.5h",
    "",
    "0m",
    "h",
    "8 h",
    "30m1h",
    "-1h",
  ])("refuses %j", (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("round-trips through parseDuration", () => {
    // Catches: the Worker naming a limit (`--ttl 12h or less`) the CLI then refuses to parse.
    for (const seconds of [1, 59, 60, 3599, 3600, 5400, 14_400, 43_200, 90_061]) {
      expect(parseDuration(formatDuration(seconds))).toBe(seconds);
    }
    expect(formatDuration(43_200)).toBe("12h");
  });
});
