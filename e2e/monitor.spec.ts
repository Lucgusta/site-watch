import { test, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";

test("public demo is read-only; capture the actual rendered dashboard", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Your sites, at a glance.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/synthetic/i).first()).toBeVisible();
  await expect(page.getByTestId("add-monitor-button")).toBeDisabled();
  const mutation = await page.request.post("/api/demo/monitors", {
    data: { name: "Blocked", url: "https://example.com" },
  });
  expect(mutation.status()).toBe(403);
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({
    path: "docs/screenshots/dashboard.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(390);
  await expect
    .poll(() =>
      page.locator(".overview-chart").evaluate((element) => {
        const chart = element.querySelector("svg");
        return (
          !chart ||
          chart.getBoundingClientRect().width <= element.clientWidth + 1
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: "docs/screenshots/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("login, create optional-email monitor, view measured details, pause and logout", async ({
  page,
}) => {
  const credentials: { username: string; password: string } = JSON.parse(
    await readFile(".runtime/e2e-login.json", "utf8"),
  );
  await page.goto("/");
  await page.getByTestId("login-button").click();
  await page.getByTestId("login-username").fill(credentials.username);
  await page.getByTestId("login-password").fill(credentials.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("add-monitor-button")).toBeEnabled();
  await page.getByTestId("add-monitor-button").click();
  await page.getByTestId("monitor-name").fill("Controlled customer website");
  await page.getByTestId("monitor-url").fill("https://example.com");
  await page.getByTestId("monitor-save").click();
  await expect(
    page.getByText("Controlled customer website", { exact: true }),
  ).toBeVisible();
  // The fixture worker uses real scheduling/persistence and controlled HTTP I/O.
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/monitors");
      return response.json();
    })
    .toMatchObject({
      items: [
        {
          notificationEmail: null,
          state: "UP",
          lastCheck: { httpStatus: 200, responseTimeMs: 142 },
        },
      ],
    });
  await page.getByText("Controlled customer website", { exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Controlled customer website",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Recent checks/ }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/details.png",
    fullPage: true,
  });
  const monitors = await (await page.request.get("/api/monitors")).json();
  const id = monitors.items[0].id as string;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/monitors/${id}`)).json()).monitor
          .state,
    )
    .toBe("PAUSED");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  expect((await page.request.get("/api/monitors")).status()).toBe(401);
});
