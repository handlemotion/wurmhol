// The start of an HTML page, read for the wall: its `<title>` and the favicon it links to.
// Pure text scanning over the first bytes of a response; the rest of the body is never read.

const TITLE_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["#39", "'"],
]);

/** The `<title>` of an HTML document's start, decoded, or null. */
export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  if (!match) return null;

  // One pass, so `&amp;lt;` decodes to `&lt;`, not `<`.
  const title = match[1]!
    .replace(
      /&(amp|lt|gt|quot|#39);/g,
      (whole: string, entity: string) => TITLE_ENTITIES.get(entity) ?? whole,
    )
    .replace(/\s+/g, " ")
    .trim();

  return title ? title.slice(0, 200) : null;
}

/** The favicon an HTML document's start links to, as a path on the share, or null. */
export function extractFaviconPath(html: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];

    if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];

    // Same-origin paths only: the relay fetches it through the CLI.
    if (href && href.startsWith("/") && !href.startsWith("//")) return href.slice(0, 500);
  }

  return null;
}

/** The first `limit` bytes of a body as text; the rest is never read. */
export async function readStart(body: ReadableStream<Uint8Array>, limit: number) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();

      if (done) break;
      text += decoder.decode(value, { stream: true });

      if (/<\/head>/i.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return text.slice(0, limit);
}
