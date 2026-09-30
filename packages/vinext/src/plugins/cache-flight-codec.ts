import MagicString from "magic-string";
import type { Plugin } from "vite";
import { magicStringTransformResult } from "./transform-result.js";

const CLIENT_CODEC =
  /\/react-server-dom-(?:webpack|turbopack)-client\.edge\.(?:development|production)\.js$/;

/**
 * React's encoder has no FormData factory option. Add just that seam to the
 * installed codec, retaining its shared server-reference registry and all its
 * serialization logic. Ordinary action encoding still uses native FormData.
 * Remove this adapter when React exposes a per-call multipart factory.
 */
export function patchCacheFlightCodec(code: string, id: string) {
  const signature =
    /function processReply\(\s*root,\s*formFieldPrefix,\s*temporaryReferences,\s*resolve,\s*reject\s*\)/g;
  const invocation =
    /exports\.encodeReply = function \(value, options\) \{[\s\S]*?var abort = processReply\([\s\S]*?\breject\s*\)/g;
  const declarations = [...code.matchAll(signature)];
  const calls = [...code.matchAll(invocation)];
  if (declarations.length !== 1 || calls.length !== 1) {
    throw new Error(
      `vinext: unsupported Flight cache encoder in ${id}; update the FormData adapter`,
    );
  }
  const output = new MagicString(code);
  const declaration = declarations[0]!;
  const call = calls[0]!;
  output.appendLeft(
    declaration.index + declaration[0].length - 1,
    ", FormData = globalThis.FormData",
  );
  output.appendLeft(call.index + call[0].length - 1, ", options && options.formDataConstructor");
  return magicStringTransformResult(output, { hires: "boundary", source: id });
}

export function cacheFlightCodecPlugin(): Plugin {
  const transform = {
    filter: { id: CLIENT_CODEC },
    handler: patchCacheFlightCodec,
  };
  return {
    name: "vinext:cache-flight-codec",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "rsc",
    configEnvironment(name) {
      if (name !== "rsc") return;
      return {
        optimizeDeps: {
          rolldownOptions: {
            plugins: [{ name: "vinext:cache-flight-codec-optimizer", transform }],
          },
        },
      };
    },
    transform,
  };
}
