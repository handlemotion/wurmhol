import { expect, it } from "vite-plus/test";
import { accessKeyHash, isAccessKey } from "./connect.ts";

// Catches: the CLI and the relay hashing a key differently (case, encoding), so a correct key is
// refused. The expected value is SHA-256 of the ASCII string, from a reference implementation.
it("hashes a key as lowercase hex SHA-256", async () => {
  expect(await accessKeyHash("a".repeat(32))).toBe(
    "3ba3f5f43b92602683c19aee62a20342b084dd5971ddd33808d81a328879a547",
  );
});

// Catches: a short or oddly-encoded key becoming the only thing between the internet and a pipe.
it.each(["short", "has space has space has space has s", `${"a".repeat(31)}!`, "a".repeat(129)])(
  "refuses %j as a key",
  (key) => {
    expect(isAccessKey(key)).toBe(false);
  },
);

it("accepts a base64url key", () => {
  expect(isAccessKey("Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4_-AB")).toBe(true);
});
