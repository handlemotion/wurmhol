// Custom domains for pipe URLs (ADR 0031): types only, until the relay serves them. A pipe that
// asks for one today is refused by the SDK with a FixError coded `unsupported`, so an app can ship
// code against these types and switch on once a server reports support.

/**
 * Where a custom domain is in being set up. The owner proves control by a DNS record the relay
 * names; the relay then issues the certificate.
 *
 * @experimental
 */
export type DomainState = "pending_dns" | "pending_certificate" | "active" | "failed" | "removed";

/**
 * A branded hostname for a pipe, like `preview.acme.dev`.
 *
 * @experimental
 */
export interface PipeDomain {
  hostname: string;
  state: DomainState;
  /** The record to create while `state` is `pending_dns`. */
  dns: { type: "CNAME" | "TXT"; name: string; value: string } | null;
  /** Why it is `failed`, in one line that says the fix. */
  fix: string | null;
}
