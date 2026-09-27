import type { Plugin } from "vite";
import { BARE_PACKAGE_SPECIFIER_RE } from "../utils/package-name.js";

/**
 * The client scanner visits server files in app/ too. Skip their server
 * externals during discovery without excluding them from actual prebundling:
 * exclusions turn optional CommonJS requires into eager browser imports.
 */
export function createClientDepScanPlugin(getServerExternals: () => readonly string[]): Plugin {
  return {
    name: "vinext:client-dep-scan",
    apply: "serve",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "client",
    resolveId: {
      filter: { id: BARE_PACKAGE_SPECIFIER_RE },
      handler(id, _importer, options) {
        // Vite passes scan to resolver hooks, but omits it from Plugin's types.
        if (!("scan" in options) || options.scan !== true) return;
        if (getServerExternals().some((name) => id === name || id.startsWith(name + "/"))) {
          return { id, external: true };
        }
      },
    },
  };
}
