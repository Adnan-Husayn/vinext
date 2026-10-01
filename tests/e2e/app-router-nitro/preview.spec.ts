import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// examples/app-router-nitro built with `vite build` and served by
// `vite preview`, which runs Nitro's own server output (#853).

test.describe("App Router on Nitro (vite preview)", () => {
  test("renders and hydrates the home page", async ({ page }) => {
    // The home page renders an eager remote image; wait for the document, not
    // the load event, and rely on the explicit hydration wait below.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveText("vinext + nitro");
    await waitForAppRouterHydration(page);

    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("1");
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
});
