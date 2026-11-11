import { expect, it } from "vitest";
import { customHostname, nextDomainState } from "./domains.ts";

it("accepts hostnames and normalizes case and a trailing dot", () => {
  expect(customHostname("preview.acme.dev")).toBe("preview.acme.dev");
  expect(customHostname(" Preview.ACME.dev. ")).toBe("preview.acme.dev");
  expect(customHostname("xn--e1afmkfd.xn--p1ai")).toBe("xn--e1afmkfd.xn--p1ai");
});

it.each([
  // Catches: routing a host that is not a name an org can own, so one org's claim shadows a local
  // or numeric address.
  ["a single label", "localhost"],
  ["an IPv4 address", "10.0.0.1"],
  ["an IPv6 address", "[::1]"],
  // Catches: a value that carries more than a host, which would land in the Cloudflare request and
  // the TXT record name unvalidated.
  ["a scheme", "https://preview.acme.dev"],
  ["a path", "preview.acme.dev/x"],
  ["a port", "preview.acme.dev:8787"],
  ["a wildcard", "*.acme.dev"],
  ["an underscore", "_dmarc.acme.dev"],
  // Catches: labels DNS rejects, which Cloudflare would refuse late and with an opaque error.
  ["a leading hyphen", "-a.acme.dev"],
  ["a trailing hyphen", "a-.acme.dev"],
  ["an empty label", "a..acme.dev"],
  ["a label over 63 characters", `${"a".repeat(64)}.acme.dev`],
  ["a name over 253 characters", `${"a.".repeat(127)}dev`],
])("refuses %s", (_label, value) => {
  expect(customHostname(value)).toBeNull();
});

const active = { status: "active", ssl: "active" } as const;

it("routes only with both proofs", () => {
  // Catches: serving a hostname whose owner never published our TXT record because its CNAME
  // already pointed at us (a name its owner abandoned, claimed by another org).
  expect(nextDomainState({ ownership: false, hostname: active, expired: false }).state).toBe(
    "pending",
  );
  expect(nextDomainState({ ownership: true, hostname: active, expired: false }).state).toBe(
    "active",
  );
});

it("stops routing when the CNAME goes away, and fails on what cannot recover", () => {
  expect(
    nextDomainState({
      ownership: true,
      hostname: { status: "moved", ssl: "active" },
      expired: false,
    }).state,
  ).toBe("verifying");
  expect(
    nextDomainState({
      ownership: true,
      hostname: { status: "blocked", ssl: "pending" },
      expired: false,
    }),
  ).toMatchObject({ state: "failed", error: "hostname_blocked" });
  expect(
    nextDomainState({
      ownership: true,
      hostname: { status: "active", ssl: "failed" },
      expired: false,
    }),
  ).toMatchObject({ state: "failed", error: "certificate_refused" });
});

it("expires an unfinished domain but never an active one", () => {
  expect(nextDomainState({ ownership: false, hostname: null, expired: true })).toMatchObject({
    state: "failed",
    error: "expired",
  });
  expect(nextDomainState({ ownership: true, hostname: active, expired: true }).state).toBe(
    "active",
  );
});

it("asks for the Cloudflare hostname when it is missing", () => {
  expect(nextDomainState({ ownership: true, hostname: null, expired: false })).toMatchObject({
    state: "verifying",
    recreate: true,
  });
});
