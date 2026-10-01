import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// examples/app-router-nitro served by `vite dev`, where Nitro replaces the
// rsc dev environment with one that has no module runner (#853).

test.describe("App Router on Nitro (vite dev)", () => {
  // The workspace installs `next`, so this also covers vinext's next/navigation
  // shim loading instead of real Next.js in Nitro's dev environments.
  test("renders and hydrates the home page", async ({ page }) => {
    // The home page renders an eager remote image; wait for the document, not
    // the load event, and rely on the explicit hydration wait below.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveText("vinext + nitro");
    await waitForAppRouterHydration(page);

    // On a cold start Vite discovers client deps after the first load and
    // reloads the page, which can reset the counter. Retry the click until the
    // hydrated page keeps the update.
    await expect(async () => {
      await page.getByTestId("increment").click();
      await expect(page.getByTestId("count")).not.toHaveText("0", { timeout: 1_000 });
    }).toPass();
  });

  test("renders a page that reads request headers", async ({ page }) => {
    const response = await page.goto("/about");
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("serves a route handler", async ({ request }) => {
    const response = await request.get("/api/hello?name=nitro");
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      message: "Hello, nitro! From vinext with nitro.",
    });
  });

  // Nitro passes requests it does not serve, such as missing assets, back to
  // Vite. @vitejs/plugin-rsc's dev handler must not take those requests, or
  // they fail with a 500 in `environment.runner.import()`.
  test("responds 404 to a missing image", async ({ request }) => {
    const response = await request.get("/missing.png", {
      headers: { "sec-fetch-dest": "image" },
    });
    expect(response.status()).toBe(404);
  });
});
