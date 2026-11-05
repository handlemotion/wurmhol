declare module "proxy-from-env" {
  /** The proxy URL for `url` from HTTPS_PROXY / HTTP_PROXY / NO_PROXY, or "" for none. */
  export function getProxyForUrl(url: string): string;
}
