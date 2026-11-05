// The few pages the Worker itself serves on a share host: ended, reconnecting, refused. Plain
// HTML with its own strict CSP, light and dark, no scripts.

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function errorPage(status: number, message: string, options: { refresh?: number } = {}) {
  const refresh = options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}">` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>Wurmhol</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0a0a0a;--muted:#737373}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3}}
body{margin:0;min-height:100svh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{padding:24px;max-width:28rem;text-align:center}
p{margin:0}small{display:block;margin-top:8px;color:var(--muted)}
</style></head>
<body><main><p>${escape(message)}</p><small>Wurmhol</small></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
