import { describe, expect, it } from "vite-plus/test";
import { hasUserClientChunkGroups } from "../packages/vinext/src/build/client-build-config.js";
import {
  collectClientReferenceRouteSignatures,
  measureClientReferenceGroupCosts,
  planClientReferenceGroups,
} from "../packages/vinext/src/build/client-reference-groups.js";

function route(pattern: string, pagePath: string, layouts: string[] = []) {
  return {
    errorPath: null,
    errorPaths: [],
    forbiddenPath: null,
    forbiddenPaths: [],
    layoutErrorPaths: [],
    layouts,
    loadingPath: null,
    notFoundPath: null,
    notFoundPaths: [],
    pagePath,
    parallelSlots: [],
    pattern,
    siblingIntercepts: [],
    templates: [],
    unauthorizedPath: null,
    unauthorizedPaths: [],
  };
}

function moduleInfo(graph: Record<string, string[]>, dynamicGraph: Record<string, string[]> = {}) {
  return (id: string) => ({
    dynamicallyImportedIds: dynamicGraph[id] ?? [],
    importedIds: graph[id] ?? [],
  });
}

function loader(modules: Record<string, { bytes: number; imports?: string[] }>) {
  return async (id: string) => {
    const module = modules[id];
    if (!module) throw new Error(`missing ${id}`);
    return { code: "x".repeat(module.bytes), importedIds: module.imports ?? [] };
  };
}

describe("collectClientReferenceRouteSignatures", () => {
  it("signs references by the routes that reach them", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set(["/nav.tsx", "/theme.tsx", "/chart.tsx", "/lazy.tsx", "/orphan"]),
      getModuleInfo: moduleInfo(
        {
          "/app/layout.tsx": ["/header.tsx", "/theme.tsx"],
          "/header.tsx": ["/nav.tsx"],
          "/app/page.tsx": ["/chart.tsx"],
        },
        { "/app/about/page.tsx": ["/lazy.tsx"] },
      ),
      routes: [
        route("/", "/app/page.tsx", ["/app/layout.tsx"]),
        route("/about", "/app/about/page.tsx", ["/app/layout.tsx"]),
      ],
    });

    expect(Object.fromEntries(signatures)).toEqual({
      "/nav.tsx": "/\n/about",
      "/theme.tsx": "/\n/about",
      "/chart.tsx": "/",
      "/lazy.tsx": "/about",
    });
  });

  it("gives references reached from shared roots their own owner", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set(["/retry.tsx", "/nav.tsx"]),
      getModuleInfo: moduleInfo({
        "/app/global-error.tsx": ["/retry.tsx", "/nav.tsx"],
        "/app/page.tsx": ["/nav.tsx"],
      }),
      routes: [route("/", "/app/page.tsx")],
      sharedRoots: ["/app/global-error.tsx"],
    });

    expect(signatures.get("/retry.tsx")).toBe("*");
    expect(signatures.get("/nav.tsx")).toBe("*\n/");
  });

  it("does not walk through client references", () => {
    const signatures = collectClientReferenceRouteSignatures({
      clientReferenceIds: new Set(["/client.tsx", "/inner.tsx"]),
      getModuleInfo: moduleInfo({
        "/app/page.tsx": ["/client.tsx"],
        "/client.tsx": ["/inner.tsx"],
      }),
      routes: [route("/", "/app/page.tsx")],
    });

    expect([...signatures.keys()]).toEqual(["/client.tsx"]);
  });
});

describe("measureClientReferenceGroupCosts", () => {
  it("charges each reference for its own modules but not shared ones", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["a", "/a.tsx"],
        ["b", "/b.tsx"],
      ]),
      loadModule: loader({
        "/a.tsx": { bytes: 10, imports: ["/a-only.ts", "/shared.ts"] },
        "/b.tsx": { bytes: 20, imports: ["/shared.ts"] },
        "/a-only.ts": { bytes: 100 },
        "/shared.ts": { bytes: 1000 },
      }),
      isExcluded: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ a: 110, b: 20 });
  });

  it("charges a reference for the client references it statically imports", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["box", "/box.tsx"],
        ["code", "/code.tsx"],
      ]),
      loadModule: loader({
        "/box.tsx": { bytes: 10, imports: ["/code.tsx"] },
        "/code.tsx": { bytes: 50, imports: ["/highlighter.ts"] },
        "/highlighter.ts": { bytes: 5000 },
      }),
      isExcluded: () => false,
    });

    expect(Object.fromEntries(costs)).toEqual({ box: 5060, code: 5050 });
  });

  it("skips excluded modules and reports unloadable graphs as unknown", async () => {
    const costs = await measureClientReferenceGroupCosts({
      references: new Map([
        ["a", "/a.tsx"],
        ["broken", "/broken.tsx"],
      ]),
      loadModule: loader({
        "/a.tsx": { bytes: 10, imports: ["/a.css", "/react.js"] },
        "/broken.tsx": { bytes: 10, imports: ["/missing.ts"] },
      }),
      isExcluded: (id) => id.endsWith(".css") || id === "/react.js",
    });

    expect(Object.fromEntries(costs)).toEqual({ a: 10, broken: null });
  });
});

describe("planClientReferenceGroups", () => {
  const signatures = new Map([
    ["/b.tsx", "/"],
    ["/a.tsx", "/"],
    ["/heavy.tsx", "/"],
    ["/unknown.tsx", "/"],
    ["/solo.tsx", "/about"],
    ["/x.tsx", "/blog"],
    ["/y.tsx", "/blog"],
  ]);
  const costs = new Map<string, number | null>([
    ["/a.tsx", 10],
    ["/b.tsx", 10],
    ["/heavy.tsx", 1000],
    ["/unknown.tsx", null],
    ["/solo.tsx", 10],
    ["/x.tsx", 10],
    ["/y.tsx", 10],
  ]);

  it("groups references that share a signature and stay under the cost cap", () => {
    const groups = planClientReferenceGroups({
      referenceIds: [...signatures.keys(), "/unsigned.tsx"],
      signatures,
      costs,
      maxCostBytes: 100,
    });

    expect(groups.map((group) => group.referenceIds)).toEqual([
      ["/a.tsx", "/b.tsx"],
      ["/x.tsx", "/y.tsx"],
    ]);
    for (const group of groups) expect(group.key).toMatch(/^[0-9a-f]{10}$/);
  });

  it("derives stable keys from the signature", () => {
    const plan = () =>
      planClientReferenceGroups({
        referenceIds: [...signatures.keys()].reverse(),
        signatures,
        costs,
        maxCostBytes: 100,
      }).map((group) => group.key);

    expect(plan()).toEqual(plan());
    expect(new Set(plan()).size).toBe(2);
  });
});

describe("hasUserClientChunkGroups", () => {
  it("detects user chunk groups at the top level and on the client environment", () => {
    expect(hasUserClientChunkGroups({})).toBe(false);
    expect(
      hasUserClientChunkGroups({
        build: { rolldownOptions: { output: { codeSplitting: { groups: [{ name: "vendor" }] } } } },
      }),
    ).toBe(true);
    expect(
      hasUserClientChunkGroups({
        environments: {
          client: {
            build: { rolldownOptions: { output: [{ manualChunks: () => undefined }] } },
          },
        },
      }),
    ).toBe(true);
    expect(
      hasUserClientChunkGroups({
        build: { rollupOptions: { output: { advancedChunks: { groups: [{ name: "x" }] } } } },
      }),
    ).toBe(true);
  });

  it("ignores code splitting options without groups", () => {
    expect(
      hasUserClientChunkGroups({
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: { experimentalInlineCommonChunks: { maxSize: 10_240 } },
            },
          },
        },
      } as never),
    ).toBe(false);
    expect(
      hasUserClientChunkGroups({
        build: { rolldownOptions: { output: { codeSplitting: { groups: [] } } } },
      }),
    ).toBe(false);
  });
});
