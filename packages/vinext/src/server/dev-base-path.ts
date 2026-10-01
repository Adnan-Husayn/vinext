import type { Connect, ViteDevServer } from "vite";
import { hasBasePath } from "../utils/base-path.js";

function pathnameOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Let requests that Vite's `base` middleware would reject reach vinext.
 *
 * vinext sets Vite's `base` to `basePath + "/"`. Vite's base middleware then
 * answers 404 for everything else, which differs from Next.js in two places:
 *
 * - The bare basePath (`/docs`) is the basePath root, not a miss.
 * - Requests outside basePath must still reach the router, where
 *   `basePath: false` rewrites, redirects and headers apply (and anything
 *   unclaimed gets the framework's own 404).
 *
 * The bare basePath is passed to Vite as `basePath + "/"`. Requests outside
 * basePath are marked and skip every middleware registered after Vite's base
 * middleware so far (public files, module transforms, static files and the
 * HTML fallback), as they did when Vite rejected them, and reach the
 * middlewares vinext registers next with their URL untouched.
 *
 * Call this after vinext has captured the Vite middlewares it invokes itself.
 */
export function patchViteBaseMiddleware(server: ViteDevServer, basePath: string): void {
  if (!basePath) return;
  const stack = server.middlewares.stack;
  const baseIndex = stack.findIndex(
    ({ handle }) => typeof handle === "function" && handle.name === "viteBaseMiddleware",
  );
  const viteBaseMiddleware = stack[baseIndex]?.handle as Connect.NextHandleFunction | undefined;
  if (!viteBaseMiddleware) return;

  stack[baseIndex].handle = function vinextBaseMiddleware(req, res, next) {
    const url = req.url ?? "/";
    const pathname = pathnameOf(url);
    if (pathname === basePath) {
      req.url = `${basePath}/${url.slice(pathname.length)}`;
      return viteBaseMiddleware(req, res, next);
    }
    if (!hasBasePath(pathname, basePath)) {
      req.__vinextOutsideBasePath = true;
      return next();
    }
    return viteBaseMiddleware(req, res, next);
  } satisfies Connect.NextHandleFunction;

  for (const entry of stack.slice(baseIndex + 1)) {
    const handle = entry.handle;
    // Connect only calls 4-argument handles for errors; leave those alone.
    if (typeof handle !== "function" || handle.length === 4) continue;
    const middleware = handle as Connect.NextHandleFunction;
    entry.handle = function skipOutsideBasePath(req, res, next) {
      if (req.__vinextOutsideBasePath) return next();
      return middleware(req, res, next);
    } satisfies Connect.NextHandleFunction;
  }
}
