import { expect, it } from "vitest";
import {
  EMBED_CREDENTIAL_PREFIXES,
  embedCredentialKind,
  embedPermissions,
  embedTtlSeconds,
  GRANT_HEADER,
  GRANT_PROTOCOL,
  GRANT_TTL,
  grantProtocolAnswer,
  grantProtocols,
  isEmbedTunnelName,
  splitGrantProtocols,
} from "./embed.ts";
import { viewerRequestHeaders } from "./headers.ts";
import { pipeName, SHARE_ID } from "./names.ts";

const secret = "A".repeat(43);
const grant = `whg_${secret}`;

// Catches: one credential kind accepted where another belongs, such as a connector used as a
// grant, or an integration key looked up as a classic `wh_` share token.
it("tells each credential kind apart, and none is a classic token", () => {
  expect(embedCredentialKind(`whk_${secret}`)).toBe("key");
  expect(embedCredentialKind(`whc_${secret}`)).toBe("connector");
  expect(embedCredentialKind(grant)).toBe("grant");
  for (const prefix of Object.values(EMBED_CREDENTIAL_PREFIXES)) {
    expect(prefix.startsWith("wh_")).toBe(false);
  }
});

it.each([
  ["a classic token", `wh_${secret}`],
  ["a short secret", `whg_${"A".repeat(42)}`],
  ["a long secret", `whg_${"A".repeat(44)}`],
  ["a padded secret", `whg_${"A".repeat(42)}=`],
  ["an unknown prefix", `whx_${secret}`],
  ["not a string", 42],
])("refuses %s as an embedded credential", (_label, value) => {
  expect(embedCredentialKind(value)).toBeNull();
});

// Catches: a typo'd permission silently granting nothing, or an empty list stored as a key
// that can do nothing and confuses the console.
it("checks a key's permissions", () => {
  expect(embedPermissions(["grants:issue", "tunnels:read", "grants:issue"])).toEqual([
    "tunnels:read",
    "grants:issue",
  ]);
  expect(embedPermissions(["tunnels:write"])).toBeNull();
  expect(embedPermissions([])).toBeNull();
});

// Catches: a grant asked for a week, or a fractional or negative lifetime, slipping past the cap.
it("bounds lifetimes", () => {
  expect(embedTtlSeconds(undefined, GRANT_TTL)).toBe(3600);
  expect(embedTtlSeconds(86_400, GRANT_TTL)).toBe(86_400);
  for (const bad of [86_401, 59, 1.5, -1, "3600"])
    expect(embedTtlSeconds(bad, GRANT_TTL)).toBeNull();
});

// Catches: the grant reaching the dev server in a header, where the app could log or leak it.
it("keeps the grant header from the dev server", () => {
  const headers = viewerRequestHeaders(
    [
      [GRANT_HEADER, grant],
      ["accept", "*/*"],
    ],
    "https://e.example",
  );
  expect(headers.some(([name]) => name.toLowerCase() === GRANT_HEADER)).toBe(false);
});

// Catches: the grant reaching the dev server through the subprotocol list, or the app's own
// protocols lost on the way.
it("splits a browser's subprotocols into the grant and the app's own", () => {
  const header = grantProtocols(grant, ["graphql-ws", "v2"]).join(", ");
  expect(splitGrantProtocols(header)).toEqual({ grant, own: ["graphql-ws", "v2"] });
});

it.each([
  ["no marker", `${GRANT_PROTOCOL}.${grant}`],
  ["two grants", `${GRANT_PROTOCOL}, ${GRANT_PROTOCOL}.${grant}, ${GRANT_PROTOCOL}.${grant}`],
  ["a connector in place of a grant", `${GRANT_PROTOCOL}, ${GRANT_PROTOCOL}.whc_${secret}`],
])("takes no grant from %s, and still hides every grant entry", (_label, header) => {
  const split = splitGrantProtocols(header);
  expect(split.grant).toBeNull();
  expect(split.own).toEqual([]);
});

// Catches: a differently cased entry slipping through to the dev server with a token in it.
it("hides grant entries in any case", () => {
  expect(splitGrantProtocols(`WURMHOL.GRANT.${grant}, chat`).own).toEqual(["chat"]);
});

// Catches: a handshake where the dev server picked no protocol failing in the browser, or the
// token echoed back in the answer.
it("answers with the app's protocol, else the marker", () => {
  expect(grantProtocolAnswer("graphql-ws")).toBe("graphql-ws");
  expect(grantProtocolAnswer(null)).toBe(GRANT_PROTOCOL);
});

// Catches: an embedded host that the Worker would route as a random pipe id, or that is not a
// pipe name and so cannot reopen at the same host.
it("names embedded tunnels as pipe names that are never pipe ids", () => {
  const name = "eabcdefghij01234";
  expect(isEmbedTunnelName(name)).toBe(true);
  expect(pipeName(name)).toBe(name);
  expect(SHARE_ID.test(name)).toBe(false);
  expect(isEmbedTunnelName("my-app")).toBe(false);
});
