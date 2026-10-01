import type { IncomingMessage } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { hasBasePath } from "../utils/base-path.js";

/**
 * URL Vite's internal middlewares see for a request outside basePath. No
 * public file, module or asset lives here, so each of them passes the request
 * on instead of serving something Next.js would not serve outside basePath.
 */
export const OUTSIDE_BASE_PATH_PLACEHOLDER_URL = "/__vinext/outside-base-path";

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
 * basePath skip Vite's internals under a placeholder URL and get their real
 * URL back from {@link restoreOutsideBasePathUrl} before vinext's handlers
 * run. Both keep `req.originalUrl`, which the App Router handler reads.
 */
export function patchViteBaseMiddleware(server: ViteDevServer, basePath: string): void {
  if (!basePath) return;
  const entry = server.middlewares.stack.find(
    ({ handle }) => typeof handle === "function" && handle.name === "viteBaseMiddleware",
  );
  const viteBaseMiddleware = entry?.handle as Connect.NextHandleFunction | undefined;
  if (!entry || !viteBaseMiddleware) return;

  const vinextBaseMiddleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? "/";
    const pathname = pathnameOf(url);
    if (pathname === basePath) {
      req.url = `${basePath}/${url.slice(pathname.length)}`;
      return viteBaseMiddleware(req, res, next);
    }
    if (!hasBasePath(pathname, basePath)) {
      req.__vinextOutsideBasePath = true;
      req.url = OUTSIDE_BASE_PATH_PLACEHOLDER_URL;
      return next();
    }
    return viteBaseMiddleware(req, res, next);
  };
  entry.handle = vinextBaseMiddleware;
}

/** Undo the placeholder URL set by {@link patchViteBaseMiddleware}. */
export function restoreOutsideBasePathUrl(req: IncomingMessage): void {
  if (!req.__vinextOutsideBasePath) return;
  req.url = (req as Connect.IncomingMessage).originalUrl ?? req.__vinextOriginalEncodedUrl ?? "/";
}
