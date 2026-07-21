/**
 * Core-flow smoke test.
 *
 * Verifies the rebuilt UI renders, controls bind to state, and the user
 * can switch trackers + drive the iterative loop without backend running.
 * /api/* calls are stubbed via Playwright route handlers.
 */

import { test, expect, type Page } from "@playwright/test";

async function stubBackend(page: Page) {
  const defaultConfig = {
    comfy_host: "127.0.0.1:8188",
    ollama_host: "127.0.0.1:11434",
    ollama_keep_model_loaded: false,
    comfy_host_override: null as string | null,
    ollama_host_override: null as string | null,
  };
  let config = { ...defaultConfig };

  // /api/workflows — returns a small set covering the workflow types.
  await page.route("**/api/workflows", async (route) => {
    const workflow = (
      path: string,
      label: string,
      category: "img" | "edit" | "inpainting",
      type: "standard" | "edit" | "inpainting",
      defaultSteps: number | null,
    ) => ({
      path,
      label,
      category,
      type,
      default_steps: defaultSteps,
      placeholders: ["input_image", "prompt", "seed", "steps"],
      output_node: "9",
      valid: true,
      errors: [],
      warnings: [],
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        workflow("img/SDXL-TURBO.json", "SDXL-TURBO", "img", "standard", 4),
        workflow(
          "edit/flux.2 klein edit.json",
          "flux.2 klein edit",
          "edit",
          "edit",
          4,
        ),
        workflow(
          "inpainting/SDXL-TURBO.json",
          "SDXL-TURBO",
          "inpainting",
          "inpainting",
          4,
        ),
      ]),
    });
  });
  // /api/images — empty list is fine for the smoke.
  await page.route("**/api/images", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    });
  });
  // /api/health (just in case)
  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", version: "0.2.0" }),
    });
  });
  await page.route("**/api/config", async (route) => {
    if (route.request().method() === "PUT") {
      const update = route.request().postDataJSON() as Partial<typeof config>;
      config = {
        ...config,
        ...update,
        ...(update.comfy_host
          ? { comfy_host_override: update.comfy_host }
          : {}),
        ...(update.ollama_host
          ? { ollama_host_override: update.ollama_host }
          : {}),
      };
    } else if (route.request().method() === "DELETE") {
      config = { ...defaultConfig };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(config),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await stubBackend(page);
  // Reset state once per test page, but not again when a test reloads to
  // verify persistence. sessionStorage survives reloads and is isolated to
  // the fresh page Playwright creates for each test.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("gazecom.e2e.initialized")) return;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("gengaze.")) localStorage.removeItem(key);
    }
    sessionStorage.setItem("gazecom.e2e.initialized", "true");
  });
});

test("welcome modal appears on first visit and closes", async ({ page }) => {
  await page.goto("/");
  const modal = page.getByRole("heading", { name: /welcome to gazecom/i });
  await expect(modal).toBeVisible();
  await page.getByRole("button", { name: /close/i }).click();
  await expect(modal).toBeHidden();
});

test("control panel renders all sections", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /close/i }).click();

  for (const section of ["Prompting", "Workflow", "Settings", "Advanced", "View"]) {
    await expect(
      page.locator("button.gz-section__title").filter({
        hasText: new RegExp(`^${section}`),
      }),
    ).toBeVisible();
  }

  await page.locator("button.gz-section__title").filter({ hasText: /^View/ }).click();
  await expect(page.getByRole("button", { name: "Medium" })).toBeVisible();
});

test("settings drawer escapes the panel and implicitly saves hosts", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /close/i }).click();
  await page
    .locator('button.gz-drawer-trigger[aria-label="Settings"]')
    .click();

  const drawer = page.locator("body > aside.gz-drawer");
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("checkbox", { name: "Skip provider errors" }),
  ).toBeVisible();

  const comfyHost = drawer.getByRole("textbox", { name: "ComfyUI host" });
  const ollamaHost = drawer.getByRole("textbox", { name: "Ollama host" });
  await expect(drawer.getByText("http://", { exact: true })).toHaveCount(2);

  const comfySave = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/config") && request.method() === "PUT",
  );
  await comfyHost.fill("comfy.test:8188");
  await comfyHost.press("Enter");
  expect((await comfySave).postDataJSON()).toEqual({
    comfy_host: "comfy.test:8188",
  });

  await expect(comfyHost).toHaveValue("comfy.test:8188");
  const ollamaSave = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/config") && request.method() === "PUT",
  );
  await ollamaHost.fill("ollama.test:11434");
  await ollamaHost.press("Enter");
  expect((await ollamaSave).postDataJSON()).toEqual({
    ollama_host: "ollama.test:11434",
  });
  await expect(ollamaHost).toHaveValue("ollama.test:11434");
  await expect(drawer.getByText("Saved ✓", { exact: true })).toHaveCount(2);

  await page.reload();
  await page
    .locator('button.gz-drawer-trigger[aria-label="Settings"]')
    .click();
  const reopenedDrawer = page.locator("body > aside.gz-drawer");
  await expect(
    reopenedDrawer.getByRole("textbox", { name: "ComfyUI host" }),
  ).toHaveValue("comfy.test:8188");
  await expect(
    reopenedDrawer.getByRole("textbox", { name: "Ollama host" }),
  ).toHaveValue("ollama.test:11434");
});

test("reset all settings clears browser and backend configuration", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /close/i }).click();
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page
    .locator('button.gz-drawer-trigger[aria-label="Settings"]')
    .click();

  const drawer = page.locator("body > aside.gz-drawer");
  const comfyHost = drawer.getByRole("textbox", { name: "ComfyUI host" });
  await comfyHost.fill("comfy.local:8188");
  await comfyHost.press("Enter");
  await expect(drawer.getByText("Saved ✓", { exact: true })).toBeVisible();
  const keepLoaded = drawer.getByRole("checkbox", {
    name: "Keep Ollama model loaded",
  });
  await keepLoaded.check();
  await expect(keepLoaded).toBeChecked();
  await expect(drawer.getByText(/Saved ✓ Ollama keeps/)).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  const resetRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/config") && request.method() === "DELETE",
  );
  await drawer.getByRole("button", { name: "Reset all settings" }).click();
  await resetRequest;
  await page.waitForLoadState("domcontentloaded");

  await expect(page.locator("body")).not.toHaveClass(/gz-theme-dark/);
  await page.getByRole("button", { name: /close/i }).click();
  await page
    .locator('button.gz-drawer-trigger[aria-label="Settings"]')
    .click();
  const resetDrawer = page.locator("body > aside.gz-drawer");
  await expect(
    resetDrawer.getByRole("textbox", { name: "ComfyUI host" }),
  ).toHaveAttribute("placeholder", "127.0.0.1:8188");
  await expect(
    resetDrawer.getByRole("checkbox", { name: "Keep Ollama model loaded" }),
  ).not.toBeChecked();
});

test("tracking-mode dropdown switches between all seven trackers", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /close/i }).click();

  const trackingSelect = page.getByRole("combobox", { name: "Mode" });
  await trackingSelect.selectOption("webgazer");
  await page
    .locator("button.gz-section__title")
    .filter({ hasText: /^Advanced/ })
    .click();
  await expect(
    page.getByRole("checkbox", { name: /Calibration cache/ }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Recalibrate" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("slider", { name: /Event history/ }),
  ).toHaveValue("300");
  await expect(
    page.getByRole("slider", { name: /Trail length/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("slider", { name: /^Dot size \d+$/ })).toHaveValue(
    "50",
  );
  await page.getByRole("combobox", { name: "Heatmap" }).selectOption("spectral");

  await trackingSelect.selectOption("handpose");
  await expect(page.getByRole("slider", { name: /Trail length/ })).toHaveValue(
    "200",
  );
  await page.getByRole("slider", { name: /Trail length/ }).fill("450");
  await page.getByRole("slider", { name: /^Dot size \d+$/ }).fill("75");

  await trackingSelect.selectOption("cursor");
  await expect(
    page.getByRole("checkbox", { name: /Calibration cache/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Recalibrate" }),
  ).toBeDisabled();
  await expect(page.getByRole("slider", { name: /Trail length/ })).toHaveValue(
    "100",
  );
  await expect(page.getByRole("slider", { name: /^Dot size \d+$/ })).toHaveValue(
    "50",
  );
  await expect(
    page.getByRole("combobox", { name: "Heatmap" }),
  ).toHaveValue("spectral");

  await trackingSelect.selectOption("handpose");
  await expect(page.getByRole("slider", { name: /Trail length/ })).toHaveValue(
    "450",
  );
  await expect(page.getByRole("slider", { name: /^Dot size \d+$/ })).toHaveValue(
    "75",
  );

  for (const option of [
    "roam",
    "roam2",
    "msi",
    "cursor",
    "vlm",
  ]) {
    await trackingSelect.selectOption(option);
    await expect(trackingSelect).toHaveValue(option);
  }
});

test("workflows populate the grouped color-coded picker", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /close/i }).click();

  await page
    .locator("button.gz-section__title")
    .filter({ hasText: /^Settings/ })
    .click();

  const workflowPicker = page.getByRole("button", { name: "Pool" });
  await workflowPicker.click();
  await expect(page.getByRole("group", { name: "IMG" })).toBeVisible();
  await expect(page.getByRole("group", { name: "EDIT" })).toBeVisible();
  await expect(page.getByRole("group", { name: "IN-/OUTPAINT" })).toBeVisible();
  const menu = page.getByRole("listbox");
  await expect(menu).toHaveCSS("position", "fixed");
  expect(await menu.evaluate((element) => element.parentElement === document.body)).toBe(
    true,
  );
  await page.getByRole("option", { name: "flux.2 klein edit" }).click();
  await expect(page.getByText("flux.2 klein edit", { exact: true })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Steps" })).toHaveValue("10");
});

test("iterative-mode toggle enables and updates the delay slider", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /close/i }).click();

  const iterativeToggle = page.getByRole("checkbox", { name: "Iterative" });
  await iterativeToggle.check();
  await expect(iterativeToggle).toBeChecked();

  // Slider becomes enabled and has min=0.
  const slider = page.getByRole("slider", { name: /^Iterative delay/ });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveAttribute("min", "0");
});

test("theme toggle adds dark class to body", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /close/i }).click();

  // Default is light → not dark.
  await expect(page.locator("body")).not.toHaveClass(/gz-theme-dark/);
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("body")).toHaveClass(/gz-theme-dark/);
});

test("settings persist across page reloads", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /close/i }).click();

  const stepsInput = page.getByRole("spinbutton", { name: "Steps" });
  await stepsInput.fill("25");

  await page.reload();
  await expect(page.getByRole("spinbutton", { name: "Steps" })).toHaveValue("25");
});
