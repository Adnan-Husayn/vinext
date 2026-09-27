import { expect, test } from "@playwright/test";

test("client dependencies can catch missing optional server-external packages", async ({
  page,
}) => {
  // Regression for https://github.com/cloudflare/vinext/issues/3484.
  await page.goto("/optional-canvas");
  await page.getByRole("button", { name: "unloaded", exact: true }).click();
  await expect(page.getByRole("button", { name: "fallback", exact: true })).toBeVisible();
});
