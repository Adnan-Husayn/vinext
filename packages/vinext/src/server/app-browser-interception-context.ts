import type { RouteManifest } from "../routing/app-route-graph.js";
import {
  matchRoutePattern,
  matchRoutePatternPrefix,
  matchRoutePatternWithOptionalDynamicSegments,
} from "../routing/route-pattern.js";
import { splitPathnameForRouteMatch } from "../routing/utils.js";
import { stripBasePath } from "../utils/base-path.js";

type ResolveManifestNavigationInterceptionContextOptions = {
  basePath: string;
  currentMatchedPathname?: string | null;
  currentPathname: string;
  routeManifest: RouteManifest | null;
  targetPathname: string;
};

/**
 * Resolve the first-hop interception context from declared route topology.
 *
 * This is intentionally manifest-only: it lets a normal browser navigation
 * ask the server for an intercepted payload when the current URL is a declared
 * interception source for the target URL, without reintroducing snapshot
 * topology as route/layout/slot authority.
 *
 * When multiple manifest interceptions match, the first one wins. That order
 * is owned by the deterministic route graph builder.
 */
export function resolveManifestNavigationInterceptionContext(
  options: ResolveManifestNavigationInterceptionContextOptions,
): string | null {
  if (options.routeManifest === null) return null;

  const currentPathname = stripBasePath(options.currentPathname, options.basePath);
  const targetPathname = stripBasePath(options.targetPathname, options.basePath);
  const sourceParts = splitPathnameForRouteMatch(currentPathname);
  const targetParts = splitPathnameForRouteMatch(targetPathname);

  for (const interception of options.routeManifest.segmentGraph.interceptions.values()) {
    if (!matchRoutePatternPrefix(sourceParts, interception.sourcePatternParts)) continue;
    if (matchRoutePattern(targetParts, interception.targetPatternParts) === null) continue;
    return currentPathname;
  }

  return null;
}

export function resolveMiddlewareRewriteNavigationInterceptionContext(
  options: ResolveManifestNavigationInterceptionContextOptions,
): string | null {
  if (options.routeManifest === null) return null;

  const currentPathname = stripBasePath(options.currentPathname, options.basePath);
  const currentMatchedPathname = options.currentMatchedPathname
    ? stripBasePath(options.currentMatchedPathname, options.basePath)
    : null;
  const targetPathname = stripBasePath(options.targetPathname, options.basePath);
  const sourceParts = splitPathnameForRouteMatch(currentPathname);
  const matchedSourceParts = currentMatchedPathname
    ? splitPathnameForRouteMatch(currentMatchedPathname)
    : null;
  const targetParts = splitPathnameForRouteMatch(targetPathname);

  for (const interception of options.routeManifest.segmentGraph.interceptions.values()) {
    if (
      !matchRoutePatternWithOptionalDynamicSegments(targetParts, interception.targetPatternParts)
    ) {
      continue;
    }
    if (matchRoutePatternPrefix(sourceParts, interception.sourcePatternParts)) {
      return currentPathname;
    }

    if (
      currentMatchedPathname !== null &&
      matchedSourceParts !== null &&
      matchRoutePatternPrefix(matchedSourceParts, interception.sourcePatternParts)
    ) {
      return encodeMatchedPathname(currentMatchedPathname);
    }
  }

  return null;
}

/**
 * The matched route pathname is decoded, but the server matches the context
 * on its raw segments, so send it encoded as the URL parser encodes it (`café`
 * becomes `caf%C3%A9`). A decoded `%` cannot be re-encoded reliably, since
 * encoded path delimiters stay escaped while literal percent signs do not, and
 * a backslash or dot segment would change the path's structure, so navigate
 * without interception for those instead.
 */
function encodeMatchedPathname(pathname: string): string | null {
  if (pathname.includes("%") || pathname.includes("\\")) return null;
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return null;
  try {
    return new URL(pathname, "http://n").pathname;
  } catch {
    return null;
  }
}
