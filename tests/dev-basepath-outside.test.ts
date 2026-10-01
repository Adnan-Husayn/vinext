/**
 * Dev-server coverage for requests at the bare basePath and outside it.
 *
 * Vite's base middleware answers `/base` with a 302 to `/base/` and every
 * other out-of-base request with its "public base URL" 404 page before vinext
 * sees it, so `basePath: false` rules never fired in dev. These cases port
 * Next.js test/e2e/basepath/basepath.test.ts and
 * test/e2e/basepath/redirect-and-rewrite.test.ts.
 * https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURES = [
  {
    name: "App Router",
    dir: path.resolve(import.meta.dirname, "./fixtures/app-basepath-outside"),
    appRouter: true,
  },
  {
    name: "Pages Router",
    dir: path.resolve(import.meta.dirname, "./fixtures/pages-basepath-outside"),
    appRouter: false,
  },
] as const;

let upstream: http.Server;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`upstream ${req.url}`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream did not bind");
  process.env.TEST_BASEPATH_OUTSIDE_UPSTREAM = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  delete process.env.TEST_BASEPATH_OUTSIDE_UPSTREAM;
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

describe.each(FIXTURES)("dev basePath boundary ($name)", ({ dir, appRouter }) => {
  let root: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    root = await createIsolatedFixture(dir, "vinext-basepath-outside-");
    ({ server, baseUrl } = await startFixtureServer(root, {
      appDir: appRouter ? root : null,
    }));
  }, 60000);

  afterAll(async () => {
    await server?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // basepath.test.ts: "should have correct router paths on first load of /"
  it("serves the index at the bare basePath without a redirect", async () => {
    for (const pathname of ["/base", "/base?x=1"]) {
      const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual" });
      expect(res.status, pathname).toBe(200);
      expect(await res.text()).toContain("Home page");
    }
  });

  it("serves pages under the basePath", async () => {
    const res = await fetch(`${baseUrl}/base/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hello World");
  });

  // basepath.test.ts: "should show 404 for page not under the /docs prefix"
  it("renders the framework 404 for a page outside the basePath", async () => {
    const res = await fetch(`${baseUrl}/hello`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Hello World");
    expect(text).not.toContain("public base URL");
  });

  // basepath.test.ts: "should serve public file with basePath correctly" and
  // "should 404 for public file without basePath"
  it("serves public files only under the basePath", async () => {
    const inside = await fetch(`${baseUrl}/base/data.txt`);
    expect(inside.status).toBe(200);
    expect(await inside.text()).toBe("hello world");

    const outside = await fetch(`${baseUrl}/data.txt`);
    expect(outside.status).toBe(404);
  });

  it("does not serve Vite modules outside the basePath", async () => {
    const res = await fetch(`${baseUrl}/@vite/client`);
    expect(res.status).toBe(404);
  });

  // redirect-and-rewrite.test.ts: "should rewrite without basePath when set to false"
  it("applies basePath: false rewrites", async () => {
    const res = await fetch(`${baseUrl}/proxy-no-basepath/api/items?id=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream /api/items?id=1");
  });

  // redirect-and-rewrite.test.ts: "should redirect with basePath by default",
  // "should not redirect without basePath without disabling" and
  // "should redirect without basePath when set to false"
  it("applies redirects on the matching side of the basePath", async () => {
    const inside = await fetch(`${baseUrl}/base/redirect-1`, { redirect: "manual" });
    expect(inside.status).toBe(307);
    expect(new URL(inside.headers.get("location") ?? "", baseUrl).pathname).toBe(
      "/base/somewhere-else",
    );

    const outsideDefault = await fetch(`${baseUrl}/redirect-1`, { redirect: "manual" });
    expect(outsideDefault.status).toBe(404);

    const outside = await fetch(`${baseUrl}/redirect-no-basepath`, { redirect: "manual" });
    expect(outside.status).toBe(307);
    expect(new URL(outside.headers.get("location") ?? "", baseUrl).pathname).toBe(
      "/another-destination",
    );
  });

  // basepath.test.ts: the "should (not) add header with/without basePath"
  // cases, plus middleware observing nextUrl.basePath on both sides.
  it("runs middleware and headers on the matching side of the basePath", async () => {
    const inside = await fetch(`${baseUrl}/base/echo`);
    expect(await inside.json()).toEqual({ basePath: "/base", pathname: "/echo" });
    expect(inside.headers.get("x-inside")).toBe("yes");
    expect(inside.headers.get("x-outside")).toBeNull();

    const outside = await fetch(`${baseUrl}/echo`);
    expect(await outside.json()).toEqual({ basePath: "", pathname: "/echo" });
    expect(outside.headers.get("x-inside")).toBeNull();
    expect(outside.headers.get("x-outside")).toBe("yes");
  });
});
