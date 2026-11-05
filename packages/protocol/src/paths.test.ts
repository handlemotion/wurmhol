import { describe, expect, it } from "vitest";
import { sameOriginPath } from "./paths.ts";

describe("sameOriginPath", () => {
  it("keeps paths on this site, with their query and fragment", () => {
    expect(sameOriginPath("/admin?x=1&y=%20#top")).toBe("/admin?x=1&y=%20#top");
    expect(sameOriginPath("/open?share=abc&next=%2F")).toBe("/open?share=abc&next=%2F");
  });

  it.each([
    // Catches: open redirects through `next`. Each of these is a path to a naive "starts with
    // one slash" check, and another site to the browser that follows it.
    ["protocol-relative", "//evil.example/x"],
    ["backslash", "/\\evil.example"],
    ["tab", "/\t/evil.example/x"],
    ["newline", "/\n/evil.example"],
    ["carriage return", "/\r/evil.example"],
    ["absolute URL", "https://evil.example/"],
    ["scheme", "javascript:alert(1)"],
    ["relative", "evil.example"],
  ])("refuses %s", (_name, value) => {
    expect(sameOriginPath(value)).toBe("/");
  });

  it("refuses nothing", () => {
    expect(sameOriginPath(null)).toBe("/");
    expect(sameOriginPath("")).toBe("/");
  });
});
