import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryCacheHandler, setCacheHandler } from "../packages/vinext/src/shims/cache.js";
import {
  registerCachedFunction,
  replayCachedFunction,
} from "../packages/vinext/src/shims/cache-runtime.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import {
  resolveModuleMetadata,
  resolveModuleViewport,
} from "../packages/vinext/src/shims/metadata.js";
import type { CacheFlightArguments } from "../packages/vinext/src/shims/cache-flight-arguments.js";
import { probeAppPageLayoutWithTracking } from "../packages/vinext/src/server/app-page-route-wiring.js";
import {
  createPprFallbackShellState,
  runWithPprFallbackShellState,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

vi.mock("@vitejs/plugin-rsc/react/rsc", async () => {
  const { loadCacheFlightCodec } = await import("./helpers/cache-flight-codec.js");
  return loadCacheFlightCodec();
});

beforeEach(() => setCacheHandler(new MemoryCacheHandler()));

// Next.js restores framework segment params separately from ordinary arguments:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/use-cache-wrapper.ts
// See isPageSegmentFunction/isLayoutSegmentFunction and their outerParams wrappers.
describe("use cache framework props", () => {
  // Next.js reinjects outerParams for cached segments so unused fallback keys
  // do not block them. Its params tests distinguish awaiting from key access:
  // https://github.com/vercel/next.js/blob/v16.3.7/packages/next/src/server/use-cache/use-cache-wrapper.ts#L2037
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/cache-components.params.test.ts
  describe.each(["$$isPage", "$$isLayout"])("fallback params for %s", (marker) => {
    it.each(["unused", "await-only", "known-key"])(
      "does not suspend when params are %s",
      async (access) => {
        const handler = new MemoryCacheHandler();
        const get = vi.spyOn(handler, "get");
        const set = vi.spyOn(handler, "set");
        setCacheHandler(handler);
        const observed: string[][] = [];
        const state = createPprFallbackShellState({
          fallbackParamNames: ["slug"],
          routePattern: "/:locale/:slug",
        });
        const cached = registerCachedFunction(
          async ({ params }: { params: Promise<{ locale: string; slug: string }> }) => {
            if (access === "unused") return "ready";
            const resolved = await params;
            return access === "known-key" ? resolved.locale : "ready";
          },
          `fallback:${marker}:${access}`,
          "",
          { argumentCount: 1 },
        );

        try {
          const result = runWithPprFallbackShellState(state, () =>
            cached({
              params: makeThenableParams(
                { locale: "en", slug: "[slug]" },
                { observeParamAccess: (keys) => observed.push([...keys]) },
              ),
              [marker]: true,
            }),
          );
          await expect(result).resolves.toBe(access === "known-key" ? "en" : "ready");
          expect(state.hasDynamicBoundary).toBe(false);
          expect(observed).toEqual(access === "known-key" ? [["locale"]] : []);
          // Placeholder params are incomplete and must not read or populate a
          // concrete route's data entry, or persist an unguarded replay.
          expect(get).not.toHaveBeenCalled();
          expect(set).not.toHaveBeenCalled();
        } finally {
          state.abortController.abort();
        }
      },
    );

    it("does not reuse a concrete placeholder-named route for a fallback key read", async () => {
      const handler = new MemoryCacheHandler();
      const get = vi.spyOn(handler, "get");
      const set = vi.spyOn(handler, "set");
      setCacheHandler(handler);
      const fn = vi.fn(
        async ({ params }: { params: Promise<{ slug: string }> }) => (await params).slug,
      );
      const cached = registerCachedFunction(fn, `fallback-collision:${marker}`, "", {
        argumentCount: 1,
      });
      const props = () => ({ params: makeThenableParams({ slug: "[slug]" }), [marker]: true });
      expect(await cached(props())).toBe("[slug]");
      expect(set).toHaveBeenCalledTimes(1);
      get.mockClear();
      set.mockClear();

      const state = createPprFallbackShellState({
        fallbackParamNames: ["slug"],
        routePattern: "/:slug",
      });
      try {
        const suspended = await runWithPprFallbackShellState(state, () =>
          cached(props()).then(
            () => false,
            (error: unknown) => error instanceof Promise,
          ),
        );
        expect(suspended).toBe(true);
        expect(state.hasDynamicBoundary).toBe(true);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(get).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();
      } finally {
        state.abortController.abort();
      }
    });

    it("keeps unbranded params consistent on warm and cold fallback-scope calls", async () => {
      const fn = vi.fn(
        async ({ params }: { params: Promise<{ slug: string }> }) => (await params).slug,
      );
      const cached = registerCachedFunction(fn, `unbranded-fallback:${marker}`);
      const props = () => ({ params: Promise.resolve({ slug: "[slug]" }), [marker]: true });
      expect(await cached(props())).toBe("[slug]");

      const state = createPprFallbackShellState({
        fallbackParamNames: ["slug"],
        routePattern: "/:slug",
      });
      try {
        expect(await runWithPprFallbackShellState(state, () => cached(props()))).toBe("[slug]");
        expect(fn).toHaveBeenCalledTimes(1);

        setCacheHandler(new MemoryCacheHandler());
        expect(await runWithPprFallbackShellState(state, () => cached(props()))).toBe("[slug]");
        expect(fn).toHaveBeenCalledTimes(2);
        // Public markers alone do not confer the factory's fallback metadata.
        expect(state.hasDynamicBoundary).toBe(false);
      } finally {
        state.abortController.abort();
      }
    });
  });

  it.each(["$$isPage", "$$isLayout"])(
    "discards unused %s props before restoration",
    async (marker) => {
      let payload: CacheFlightArguments | undefined;
      const fn = vi.fn(async () => "rendered");
      const cached = registerCachedFunction(fn, `no-args:${marker}`, "", {
        argumentCount: 0,
        serverReferenceId: `no-args:${marker}`,
        encodeInvocation: async (args) => {
          payload = args;
          return "encrypted";
        },
      });
      const call = (slug: string) =>
        Reflect.apply(cached, null, [
          {
            params: makeThenableParams({ slug }),
            searchParams: Promise.resolve({ query: slug }),
            [marker]: true,
          },
        ]);
      expect(await call("first")).toBe("rendered");
      expect(await call("second")).toBe("rendered");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith();
      expect(payload?.pagePropsIndex).toBeUndefined();
      setCacheHandler(new MemoryCacheHandler());
      expect(await replayCachedFunction(cached, payload!)).toBe("rendered");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith();
    },
  );

  it("restores layout params, preserves slots, and replays the same key", async () => {
    const handler = new MemoryCacheHandler();
    const set = vi.spyOn(handler, "set");
    setCacheHandler(handler);
    const payloads: CacheFlightArguments[] = [];
    const fn = vi.fn(
      async (props: {
        params: ReturnType<typeof makeThenableParams<{ slug: string }>>;
        children: unknown;
        sidebar: string;
      }) => ({
        sync: props.params.slug,
        async: (await props.params).slug,
        children: props.children,
        sidebar: props.sidebar,
        keys: Object.keys(props),
      }),
    );
    const cached = registerCachedFunction(fn, "layout-props", "", {
      argumentCount: 1,
      serverReferenceId: "layout-props",
      encodeInvocation: async (args) => {
        payloads.push(args);
        return "encrypted";
      },
    });
    const child = createElement("p", null, "child");
    const call = (slug: string) =>
      cached({
        params: makeThenableParams({ slug }),
        children: child,
        sidebar: "slot",
        $$isLayout: true,
      } as Parameters<typeof cached>[0]);
    expect(await call("first")).toEqual({
      sync: "first",
      async: "first",
      children: child,
      sidebar: "slot",
      keys: ["params", "children", "sidebar"],
    });
    expect((await call("second")).sync).toBe("second");
    expect((await call("first")).sync).toBe("first");
    expect(fn).toHaveBeenCalledTimes(2);
    const replayHandler = new MemoryCacheHandler();
    const replaySet = vi.spyOn(replayHandler, "set");
    setCacheHandler(replayHandler);
    await replayCachedFunction(cached, payloads[0]!);
    expect(replaySet.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0]);
    expect((await call("first")).sync).toBe("first");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it.each(["metadata", "viewport"])("marks layout %s invocations", async (kind) => {
    const fn = vi.fn(
      async ({ params }: { params: ReturnType<typeof makeThenableParams<{ slug: string }>> }) =>
        kind === "metadata" ? { title: params.slug } : { themeColor: params.slug },
    );
    const cached = registerCachedFunction(fn, `layout-${kind}`, "", { argumentCount: 1 });
    const resolve = (slug: string) =>
      kind === "metadata"
        ? resolveModuleMetadata({ generateMetadata: cached }, { slug })
        : resolveModuleViewport({ generateViewport: cached }, { slug });
    expect(await resolve("first")).toEqual(
      kind === "metadata" ? { title: "first" } : { themeColor: "first" },
    );
    expect(await resolve("second")).toEqual(
      kind === "metadata" ? { title: "second" } : { themeColor: "second" },
    );
    await resolve("first");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("marks layout probes before invoking the cached component", async () => {
    const observed: string[] = [];
    const Layout = registerCachedFunction(
      async ({ params }: { params?: unknown }) => {
        observed.push((params as ReturnType<typeof makeThenableParams<{ slug: string }>>).slug);
        return null;
      },
      "layout-probe",
      "",
      { argumentCount: 1 },
    );
    const probe = (slug: string) =>
      probeAppPageLayoutWithTracking({
        layoutIndex: 0,
        layoutParamAccess: undefined,
        makeThenableParams,
        matchedParams: { slug },
        route: {
          layoutTreePositions: [1],
          layouts: [{ default: Layout }],
          routeSegments: ["[slug]"],
        },
      });
    await probe("first");
    await probe("second");
    await probe("first");
    expect(observed).toEqual(["first", "second"]);
  });
});
