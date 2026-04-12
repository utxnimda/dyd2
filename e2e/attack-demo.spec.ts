import { expect, test } from "@playwright/test";

const mockMoneyList = {
  code: 0,
  data: {
    list: Array.from({ length: 16 }, (_, i) => ({
      id: i + 1,
      name: `队长${i + 1}`,
      avatar: `avatar${i + 1}.jpg`,
      balance: 100_000,
      card: `card-${i + 1}`,
      enable: "1",
    })),
  },
};

test("演示进攻效果：出现 hit 飘字与红闪类名", async ({ page }) => {
  await page.route("**/__fmz_reactions/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/votes?")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ code: 0, data: { likes: {}, dislikes: {} } }),
      });
      return;
    }
    if (url.includes("/api/votes/inc")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          code: 0,
          data: { memberId: "1", likes: 1, dislikes: 0 },
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });
  await page.route("**/dy888/money/list", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockMoneyList),
    });
  });
  await page.route("**/dy888/money/record/list", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code: 0, data: { list: [] } }),
    });
  });

  await page.goto("/#captain-hud");
  await expect(page.locator("section.hud .bar")).toBeVisible({
    timeout: 20_000,
  });
  const demo = page.locator("section.hud .bar button.btn-demo");
  await expect(demo).toBeEnabled();
  await demo.click();
  await expect(page.locator(".floater.hit").first()).toBeVisible({
    timeout: 8000,
  });
  await expect(page.locator(".slot.ishit").first()).toBeVisible({
    timeout: 3000,
  });
});
