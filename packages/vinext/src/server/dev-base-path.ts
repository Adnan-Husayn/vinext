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
 * basePath are marked and passed on with their URL untouched. Vite's own
 * middlewares after the base middleware (public files, module transforms,
 * static files, the HTML fallback) must skip them, as they did when Vite
 * rejected them; middlewares from other plugins still run.
 *
 * Returns the function that installs that skip. Call it once vinext has
 * captured the Vite middlewares it invokes itself and replaced any of their
 * handles.
 */
export function patchViteBaseMiddleware(server: ViteDevServer, basePath: string): () => void {
  if (!basePath) return () => {};
  const stack = server.middlewares.stack;
  const baseIndex = stack.findIndex(
    ({ handle }) => typeof handle === "function" && handle.name === "viteBaseMiddleware",
  );
  const viteBaseMiddleware = stack[baseIndex]?.handle as Connect.NextHandleFunction | undefined;
  if (!viteBaseMiddleware) return () => {};

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

  // Vite names every internal middleware `vite…`, except the editor launcher
  // it mounts at /__open-in-editor.
  const viteEntries = stack
    .slice(baseIndex + 1)
    .filter(
      ({ handle, route }) =>
        route === "/__open-in-editor" ||
        (typeof handle === "function" && /^vite[A-Z]/.test(handle.name)),
    );

  return () => {
    for (const entry of viteEntries) {
      const handle = entry.handle;
      // Connect only calls 4-argument handles for errors; leave those alone.
      if (typeof handle !== "function" || handle.length === 4) continue;
      const middleware = handle as Connect.NextHandleFunction;
      entry.handle = function skipOutsideBasePath(req, res, next) {
        if (req.__vinextOutsideBasePath) return next();
        return middleware(req, res, next);
      } satisfies Connect.NextHandleFunction;
    }
  };
}
