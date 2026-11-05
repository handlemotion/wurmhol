import { expect, it } from "vitest";
import { pipeName } from "./names.ts";

it("accepts DNS labels and lowercases them", () => {
  expect(pipeName("my-app")).toBe("my-app");
  expect(pipeName(" MyApp2 ")).toBe("myapp2");
});

it.each([
  // Catches: a name that the Worker would route as a random pipe id instead, so one org's named
  // host could land on another pipe.
  ["the shape of a random id", "abcdefghij"],
  // Catches: hosts browsers read as punycode, or that are not one valid DNS label.
  ["an internationalized prefix", "xn--abc"],
  ["a double hyphen", "my--app"],
  ["a leading digit", "1app"],
  ["a trailing hyphen", "app-"],
  ["a dot", "my.app"],
  ["too short", "ab"],
  ["too long", `a${"b".repeat(40)}`],
])("refuses %s", (_label, value) => {
  expect(pipeName(value)).toBeNull();
});
