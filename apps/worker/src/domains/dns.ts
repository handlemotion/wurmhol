// Reads a TXT record over DNS-over-HTTPS (ADR 0030): the proof that an org owns a hostname. The
// Worker has no resolver of its own, and DoH is a plain fetch.

/** The resolver failed or did not answer: the caller may try again; it says nothing about the record. */
export class DnsError extends Error {}

interface DohAnswer {
  Status?: number;
  Answer?: { type?: number; data?: string }[];
}

/** A TXT record's `data` as the strings it holds: `"a" "b"` is one value, `ab`. */
function txtValue(data: string) {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1]!.replace(/\\(.)/g, "$1"),
  );
  return parts.length ? parts.join("") : data;
}

/** The TXT values at `name`. Empty when there is none (NXDOMAIN or no TXT). */
export async function lookupTxt(resolverUrl: string, name: string): Promise<string[]> {
  const url = new URL(resolverUrl);
  url.searchParams.set("name", name);
  url.searchParams.set("type", "TXT");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new DnsError("the DNS resolver did not answer");
  }
  if (!response.ok) throw new DnsError(`the DNS resolver answered HTTP ${response.status}`);
  const answer = (await response.json().catch(() => null)) as DohAnswer | null;
  if (!answer) throw new DnsError("the DNS resolver's answer was not JSON");
  // 0 NOERROR, 3 NXDOMAIN: both are answers. SERVFAIL (2) and the rest are the resolver's trouble.
  if (answer.Status !== 0 && answer.Status !== 3) {
    throw new DnsError(`the DNS resolver failed (status ${answer.Status})`);
  }
  return (answer.Answer ?? []).filter((a) => a.type === 16 && a.data).map((a) => txtValue(a.data!));
}
