// The transport for Client ID Metadata Documents (ADR 0014): the Worker fetches a URL the MCP
// client chose, so the fetch is fenced here. `@better-auth/cimd` has already checked the
// `client_id` URL (HTTPS, a public hostname, no IP literals for private ranges) before it calls
// this; this repeats that check for every URL it is handed, and adds what a fetch can enforce.
//
// The plugin asks a runtime transport to resolve DNS once and pin the address. A Worker cannot:
// `fetch` resolves names itself. Its egress is Cloudflare's network, which has no route into a
// private network of ours, so a name that resolves to 10.0.0.1 reaches nothing of Wurmhol's.
import { validateClientIdUrl } from "@better-auth/cimd";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";

/** A metadata document is a few hundred bytes; 64 KiB leaves room and caps what we read. */
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;

/** Reads at most `MAX_BYTES` of a body, or throws. */
async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new Error("client metadata document too large");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("client metadata document too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * HTTPS only, public hosts only, no redirects followed (the plugin refuses a 3xx), 5 s, 64 KiB.
 * No cookies or credentials of ours are ever attached.
 */
export const fetchClientMetadata: ClientMetadataResourceFetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const problem = validateClientIdUrl(url);
  if (problem) throw new Error(`refused client metadata URL: ${problem}`);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  const body = await boundedBody(response);
  return new Response(response.status === 204 || response.status === 304 ? null : body, {
    status: response.status,
    headers: response.headers,
  });
};
