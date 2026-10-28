export const PUBLIC_DATA_PREFIX = "/data";

/**
 * Convert the public `/data` route into the historical prefix-free API route.
 * Prefix-free paths are also accepted for workers.dev and local smoke tests.
 * Paths such as `/database` may be captured by Cloudflare's `/data*` route,
 * but are deliberately rejected instead of being mistaken for `/data`.
 */
export function internalPathname(pathname: string): string | null {
  if (pathname === PUBLIC_DATA_PREFIX) return "/";
  if (pathname.startsWith(`${PUBLIC_DATA_PREFIX}/`)) {
    return pathname.slice(PUBLIC_DATA_PREFIX.length);
  }
  if (pathname.startsWith(PUBLIC_DATA_PREFIX)) return null;
  return pathname;
}
