import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { collectHostEntryOptimizeDepsIncludes } from "../packages/vinext/src/plugins/host-entry-optimize-deps.js";

describe("collectHostEntryOptimizeDepsIncludes", () => {
  let root: string;
  let packageRoot: string;

  function write(relativePath: string, contents: string): string {
    const file = path.join(packageRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-host-entry-deps-"));
    packageRoot = path.join(root, "node_modules", "@adapter", "platform");
    write("package.json", JSON.stringify({ name: "@adapter/platform", type: "module" }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("follows relative imports within the owning package", () => {
    // A nameless manifest (for example a dist `type` marker) must not hide the
    // real owner.
    write("dist/package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      "dist/entry.worker.js",
      [
        'import "side-effect-dep";',
        'import { createStore } from "@scope/store";',
        'import { helper } from "./shared/helper.js";',
        'export { stage } from "../lib/stage.js";',
        'export * from "./all.js";',
        "export default createStore(helper);",
      ].join("\n"),
    );
    write("dist/shared/helper.js", 'import { request } from "vinext/server/request-stage";\n');
    write("lib/stage.js", 'export { stage } from "stage-lib/runtime";\n');
    write("dist/all.js", 'export * from "all-lib";\nimport { store } from "@scope/store";\n');

    expect(collectHostEntryOptimizeDepsIncludes(entry).sort()).toEqual([
      "@scope/store",
      "all-lib",
      "side-effect-dep",
      "stage-lib/runtime",
      "vinext/server/request-stage",
    ]);
  });

  it("skips type-only imports", () => {
    const entry = write(
      "entry.ts",
      [
        'import type { Store } from "type-only-import";',
        'import { type Options } from "type-only-specifier";',
        'export type { Env } from "type-only-export";',
        'export { type Binding } from "type-only-export-specifier";',
        'export type * from "type-only-export-all";',
        'import { type Mixed, runtime } from "mixed-specifiers";',
        'import {} from "empty-specifiers";',
        "export const value = runtime as unknown as Store & Options;",
      ].join("\n"),
    );

    expect(collectHostEntryOptimizeDepsIncludes(entry).sort()).toEqual([
      "empty-specifiers",
      "mixed-specifiers",
    ]);
  });

  it("skips builtins, protocol and virtual ids, package imports, and self-imports", () => {
    const entry = write(
      "entry.js",
      [
        'import fs from "fs";',
        'import { readFile } from "fs/promises";',
        'import { Buffer } from "node:buffer";',
        'import { WorkerEntrypoint } from "cloudflare:workers";',
        'import options from "virtual:vinext-cdn-cache-adapter";',
        'import internal from "#internal";',
        'import self from "@adapter/platform";',
        'import selfSubpath from "@adapter/platform/runtime";',
        'import absolute from "/absolute/module.js";',
        'import real from "real-dep";',
      ].join("\n"),
    );

    expect(collectHostEntryOptimizeDepsIncludes(entry)).toEqual(["real-dep"]);
  });

  it("does not follow relative imports that leave the owning package", () => {
    const outside = path.join(root, "node_modules", "other-package");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "other-package" }));
    fs.writeFileSync(path.join(outside, "index.js"), 'import "outside-dep";\n');
    const entry = write(
      "entry.js",
      'import "../../other-package/index.js";\nimport "inside-dep";\n',
    );

    expect(collectHostEntryOptimizeDepsIncludes(entry)).toEqual(["inside-dep"]);
  });

  it("tolerates missing files, cycles, and unparsable modules", () => {
    const entry = write(
      "entry.js",
      [
        'import "./missing.js";',
        'import "./cycle.js";',
        'import "./broken.js";',
        'import "./data.json";',
        'import "entry-dep";',
      ].join("\n"),
    );
    write("cycle.js", 'import "./entry.js";\nimport "cycle-dep";\n');
    write("broken.js", 'import "broken-dep";\nexport const = ;\n');
    write("data.json", "{}");

    expect(collectHostEntryOptimizeDepsIncludes(entry).sort()).toEqual(["cycle-dep", "entry-dep"]);
  });

  it("caps the number of visited files", () => {
    const fileCount = 100;
    for (let index = 0; index < fileCount; index++) {
      const next = index + 1 < fileCount ? `import "./file-${index + 1}.js";\n` : "";
      write(`file-${index}.js`, `${next}import "dep-${index}";\n`);
    }

    const includes = collectHostEntryOptimizeDepsIncludes(path.join(packageRoot, "file-0.js"));
    expect(includes).toHaveLength(64);
    expect(includes).toContain("dep-0");
    expect(includes).toContain("dep-63");
    expect(includes).not.toContain("dep-64");
  });
});
