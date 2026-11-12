// The few pages the Worker itself serves on a share host: ended, reconnecting, refused. Plain
// HTML with its own strict CSP, light and dark, no scripts.
//
// Behind the message is the wall's network drawing (`page-plate.ts`): the two places a pipe
// joins, with the line between them gone. It is inline SVG at true size. The drawing and the
// message are both fixed at the viewport's centre, the same reference box, so the message always
// sits in the drawing's hole however the browser sizes the viewport.
import { PLATE } from "./page-plate";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function errorPage(status: number, message: string, options: { refresh?: number } = {}) {
  const refresh = options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}">` : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>Wurmhol</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0a0a0a;--muted:#737373;--line:#e8e8e8}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3;--line:#262626}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);box-sizing:border-box;width:min(28rem,100%);padding:24px;text-align:center}
svg{position:fixed;left:50%;top:50%;width:3600px;height:2400px;margin:-1200px 0 0 -1800px;color:var(--line);pointer-events:none}
p{margin:0}small{display:block;margin-top:8px;color:var(--muted)}
</style></head>
<body><svg viewBox="-1800 -1200 3600 2400" aria-hidden="true">${PLATE}</svg><main><p>${escape(message)}</p><small>Wurmhol</small></main></body></html>`;

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
