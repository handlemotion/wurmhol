// Serves the docs at `/docs` on the site's own host by proxying to a Mintlify deployment.
// wrangler.jsonc runs this only for the paths below; every other path is a static file.
// With DOCS_HOST empty (self-hosted installs without docs) these paths fall through to the
// static files too, which answer with the 404 page.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  // The Mintlify deployment's host, `<subdomain>.mintlify.site`.
  DOCS_HOST: string;
}

// Mintlify serves pages under the base path, and its CSS, JS, fonts and API (`POST`s included)
// from the domain root. It verifies the custom domain through `/.well-known/vercel/`.
const DOCS_PATH = /^\/(docs(\/|$)|_mintlify\/|mintlify-assets\/|\.well-known\/vercel\/)/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!env.DOCS_HOST || !DOCS_PATH.test(url.pathname)) return env.ASSETS.fetch(request);

    const host = url.host;
    url.host = env.DOCS_HOST;
    const proxied = new Request(url, request);
    proxied.headers.set("X-Forwarded-Host", host);
    proxied.headers.set("X-Forwarded-Proto", "https");
    return fetch(proxied);
  },
};
