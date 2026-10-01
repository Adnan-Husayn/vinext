import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

type RecorderWindow = Window & { __PARAMS_HISTORY_RENDERS__?: string[] };

// Back/Forward restore a cached tree synchronously. Client params used to stay
// staged until after that render, so the restored page rendered once with the
// previous route's params (here: no `id`) before correcting itself.
test("useParams never shows the previous route's params on Back/Forward", async ({ page }) => {
  await page.goto(`${BASE}/params-history`);
  await waitForAppRouterHydration(page);

  await page.click("#params-history-item");
  await expect(page.locator("#params-history-id")).toHaveText("item-1");

  for (let i = 0; i < 2; i++) {
    await page.goBack();
    await expect(page.locator("#params-history-title")).toHaveText("Params history list");

    await page.evaluate(() => {
      (window as RecorderWindow).__PARAMS_HISTORY_RENDERS__ = [];
    });
    await page.goForward();
    await expect(page.locator("#params-history-id")).toHaveText("item-1");

    const renders = await page.evaluate(
      () => (window as RecorderWindow).__PARAMS_HISTORY_RENDERS__ ?? [],
    );
    expect(renders.length).toBeGreaterThan(0);
    expect(
      renders.every((id) => id === "item-1"),
      JSON.stringify(renders),
    ).toBe(true);
  }
});
