import { expect, test, Page } from "playwright/test";

type Position = { x: number; y: number };
declare global {
  interface Window {
    tabletopTest: {
      state: () => {
        count: number;
        drawStage: "river" | "land";
        tileId?: string;
        riverCount: number;
        phase: string;
        orientation: number;
        legal: Position[];
        scores: number[];
        claims: unknown[];
        over: boolean;
      };
      point: (position: Position) => Position;
      renderedLegal: () => Position[];
      completedMarkers: () => number;
      stats: () => {
        calls: number;
        triangles: number;
        frame: number;
        zoom: number;
        camera: number[];
        geometries: number;
        textures: number;
      };
      loseContext: () => void;
      cameraTarget: () => number[];
      cameraUp: () => number[];
      dustVisible: () => boolean;
      landingWarehouseHeight: () => number | null;
      tileHeight: (position: Position) => number;
      previewFrame: () => number;
      losePreviewContext: () => void;
    };
  }
}
async function ready(page: Page, suffix = "") {
  await page.goto(`/e2e/tabletop.html${suffix}`);
  await sceneReady(page);
}

/** Waits until the 3D scene has registered and drawn, which lags the canvas on slow machines. */
async function sceneReady(page: Page) {
  await expect(page.getByTestId("board-3d")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          return window.tabletopTest.stats().calls;
        } catch {
          return 0;
        }
      }),
    )
    .toBeGreaterThan(0);
}
async function legalPoint(page: Page) {
  for (let i = 0; i < 4; i++) {
    const legal = await page.evaluate(() => window.tabletopTest.state().legal);
    if (legal.length) {
      // Demand frames can belong to an earlier orientation. Wait for the actual
      // legal-cell geometry to reach the scene before clicking its projection.
      await expect.poll(() => page.evaluate(() => window.tabletopTest.renderedLegal())).toEqual(legal);
      return page.evaluate((position) => window.tabletopTest.point(position), legal[0]);
    }
    const frame = await page.evaluate(() => window.tabletopTest.stats().frame);
    await page.getByRole("button", { name: "Rotate tile", exact: true }).click();
    // Legal cells in the DOM update before the separate R3F root has drawn
    // them. Click the rendered orientation, not the previous frame's cells.
    await expect.poll(() => page.evaluate(() => window.tabletopTest.stats().frame)).toBeGreaterThan(frame);
  }
  throw new Error("No legal placement in any rotation");
}

test("the 3D preview redraws every quarter turn and returns to its original image", async ({ page }) => {
  await ready(page);
  const preview = page.locator(".tabletop-tile-preview canvas");
  await expect(preview).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.tabletopTest.previewFrame())).toBeGreaterThan(0);
  const original = await preview.screenshot();
  let previous = original;
  for (let rotation = 1; rotation <= 4; rotation++) {
    const frame = await page.evaluate(() => window.tabletopTest.previewFrame());
    await page.getByRole("button", { name: "Rotate tile", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.tabletopTest.previewFrame())).toBeGreaterThan(frame);
    const current = await preview.screenshot();
    expect(current.equals(previous)).toBe(false);
    if (rotation === 4) expect(current.equals(original)).toBe(true);
    previous = current;
  }
  const idleFrame = await page.evaluate(() => window.tabletopTest.previewFrame());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.tabletopTest.previewFrame())).toBe(idleFrame);
});

test("a preview context failure keeps the board and game in 3D", async ({ page }) => {
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.tabletopTest.previewFrame())).toBeGreaterThan(0);
  const state = await page.evaluate(() => window.tabletopTest.state());
  await page.evaluate(() => window.tabletopTest.losePreviewContext());
  // Only the preview gives up; the board keeps rendering in 3D.
  await expect(page.locator(".tabletop-tile-preview")).toHaveCount(0);
  await expect(page.getByTestId("board-3d")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tabletop" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.tabletopTest.state())).toEqual(state);
  const point = await legalPoint(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("tile-count")).toHaveText("2");
  await page.getByRole("button", { name: "Skip claim" }).click();
  await expect(page.locator(".tabletop-tile-preview")).toHaveCount(0);
  await expect(page.getByTestId("board-3d")).toBeVisible();
});

test("placement and claiming reuse the same preview canvas across turns", async ({ page }, testInfo) => {
  await ready(page);
  const canvas = await page.locator(".tabletop-tile-preview canvas").elementHandle();
  expect(canvas).not.toBeNull();
  for (let turn = 0; turn < 20; turn++) {
    const state = await page.evaluate(() => window.tabletopTest.state());
    expect(state.drawStage).toBe(turn < 11 ? "river" : "land");
    if (turn === 10) expect(state.tileId).toBe("river-lake");
    if (turn === 11) {
      expect(state.riverCount).toBe(12);
      await page.screenshot({ path: testInfo.outputPath("completed-river-3d.png"), fullPage: true });
    }
    await expect.poll(() => page.evaluate(() => window.tabletopTest.previewFrame())).toBeGreaterThan(0);
    const boardFrame = await page.evaluate(() => window.tabletopTest.stats().frame);
    await page.getByRole("button", { name: "Fit board", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.tabletopTest.stats().frame)).toBeGreaterThan(boardFrame);
    const point = await legalPoint(page);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByTestId("tile-count")).toHaveText(String(turn + 2));
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.locator(".tabletop-tile-preview")).toBeHidden();
    const claimFrame = await page.evaluate(() => window.tabletopTest.previewFrame());
    await page.getByRole("button", { name: "Skip claim" }).click();
    await expect(page.locator(".tabletop-tile-preview")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.tabletopTest.previewFrame())).toBeGreaterThan(claimFrame);
    expect(
      await canvas!.evaluate((element) => element === document.querySelector(".tabletop-tile-preview canvas")),
    ).toBe(true);
    await expect(page.getByTestId("board-3d")).toBeVisible();
  }
  // R3F's delayed context teardown must not switch a later turn to 2D.
  await page.waitForTimeout(700);
  await expect(page.getByTestId("board-3d")).toBeVisible();
});

test("desktop placement, dragging, rotation, claiming and view switching preserve the game", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  const start = await legalPoint(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y + 30, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.tabletopTest.state().count)).toBe(1);
  const manualCamera = await page.evaluate(() => window.tabletopTest.stats().camera);
  await page.getByRole("button", { name: "Rotate tile", exact: true }).click();
  expect(await page.evaluate(() => window.tabletopTest.stats().camera)).toEqual(manualCamera);
  await page.getByRole("button", { name: "Fit board", exact: true }).click();
  const placement = await legalPoint(page);
  await page.mouse.move(placement.x, placement.y);
  await page.mouse.click(placement.x, placement.y);
  await expect(page.getByTestId("tile-count")).toHaveText("2");
  await expect(page.getByTestId("phase")).toHaveText("claim_feature");
  await page
    .getByRole("button", { name: /^Claim / })
    .first()
    .click();
  await expect(page.getByTestId("phase")).toHaveText("place_tile");
  const state = await page.evaluate(() => window.tabletopTest.state());
  expect(state.claims.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Drone" }).click();
  await expect(page.getByTestId("board-3d")).toBeVisible();
  expect(await page.evaluate(() => window.tabletopTest.state())).toEqual(state);
  await page.getByRole("button", { name: "Tabletop" }).click();
  await expect(page.getByTestId("board-3d")).toBeVisible();
  expect(await page.evaluate(() => window.tabletopTest.state())).toEqual(state);
  expect(errors).toEqual([]);
});

test("tablet tap previews before confirmation and fits without horizontal overflow", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const point = await legalPoint(page);
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.getByRole("button", { name: "Place tile", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.tabletopTest.state().count)).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).tap();
  expect(await page.evaluate(() => window.tabletopTest.state().count)).toBe(1);
  await page.touchscreen.tap(point.x, point.y);
  await page.getByRole("button", { name: "Place tile", exact: true }).tap();
  await expect(page.getByTestId("tile-count")).toHaveText("2");
  await page.screenshot({
    path: "test-results/tabletop-tablet.png",
    fullPage: true,
  });
  await context.close();
});

test("pinch zoom never places a tile or opens a confirmation", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await ready(page);
  const point = await legalPoint(page);
  const before = await page.evaluate(() => window.tabletopTest.stats().zoom);
  const client = await context.newCDPSession(page);
  const touches = (distance: number) => [
    { x: point.x - distance, y: point.y, id: 1 },
    { x: point.x + distance, y: point.y, id: 2 },
  ];
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: touches(30),
  });
  for (const distance of [40, 50, 65])
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touches(distance),
    });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  expect(await page.evaluate(() => window.tabletopTest.state().count)).toBe(1);
  await expect(page.getByRole("button", { name: "Place tile", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.tabletopTest.stats().zoom)).toBeGreaterThan(before);
  await context.close();
});

test("context loss shows a retry panel without losing tiles, claims or scores", async ({ page }) => {
  await ready(page);
  const point = await legalPoint(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("tile-count")).toHaveText("2");
  const before = await page.evaluate(() => window.tabletopTest.state());
  await page.evaluate(() => window.tabletopTest.loseContext());
  await expect(page.getByText("3D graphics aren't available right now")).toBeVisible();
  await expect(page.getByTestId("board-3d")).toHaveCount(0);
  expect(await page.evaluate(() => window.tabletopTest.state())).toEqual(before);
  // A fresh canvas asks for a new context, and the game carries on.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("board-3d")).toBeVisible();
  // The remounted canvas registers its renderer a moment after it appears.
  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          return window.tabletopTest.stats().frame;
        } catch {
          return 0;
        }
      }),
    )
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.tabletopTest.state())).toEqual(before);
});

test("devices without WebGL get the unavailable panel instead of a crash", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type.includes("webgl")) return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e/tabletop.html");
  await expect(page.getByText("3D graphics aren't available right now")).toBeVisible();
  // Retrying on a device that still has no WebGL lands back on the panel.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("3D graphics aren't available right now")).toBeVisible();
  await expect(page.getByTestId("tile-count")).toHaveText("1");
  expect(errors).toEqual([]);
});

test("full-deck scenery renders efficiently and stops drawing when idle", async ({ page }) => {
  await ready(page, "?full");
  expect(await page.evaluate(() => window.tabletopTest.state().over)).toBe(true);
  expect(await page.evaluate(() => window.tabletopTest.state().count)).toBeGreaterThan(40);
  await page.waitForTimeout(500);
  const first = await page.evaluate(() => window.tabletopTest.stats());
  expect(first.calls).toBeLessThan(350);
  expect(first.triangles).toBeLessThan(150000);
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => window.tabletopTest.stats())).frame).toBe(first.frame);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.tabletopTest.stats().frame)).toBeGreaterThan(first.frame);
  await page.screenshot({
    path: "test-results/tabletop-full-deck.png",
    fullPage: true,
  });
  console.log("Full-deck rendering:", first);
});

test("extra effects at night keep the full board moving within the draw budget", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await ready(page, "?full&vfx&night");
  await page.waitForTimeout(500);
  const first = await page.evaluate(() => window.tabletopTest.stats());
  // Water, wind, windpumps and fireflies all need fresh frames.
  await expect.poll(() => page.evaluate(() => window.tabletopTest.stats().frame)).toBeGreaterThan(first.frame + 5);
  const stats = await page.evaluate(() => window.tabletopTest.stats());
  expect(stats.calls).toBeLessThan(350);
  expect(stats.triangles).toBeLessThan(150000);
  await page.screenshot({ path: "test-results/tabletop-night-effects.png", fullPage: true });
  expect(errors).toEqual([]);
  console.log("Night effects rendering:", stats);
});

test("zooming out sheds scenery detail and zooming back in restores it", async ({ page }) => {
  await ready(page, "?full");
  const zoomTo = async (label: "Zoom in" | "Zoom out", clicks: number) => {
    for (let i = 0; i < clicks; i++) {
      const frame = await page.evaluate(() => window.tabletopTest.stats().frame);
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.tabletopTest.stats().frame)).toBeGreaterThan(frame);
    }
    return page.evaluate(() => window.tabletopTest.stats());
  };
  const near = await zoomTo("Zoom in", 4);
  const far = await zoomTo("Zoom out", 7);
  const back = await zoomTo("Zoom in", 7);
  expect(near.zoom).toBeGreaterThan(71);
  expect(far.zoom).toBeLessThan(28);
  // Zoomed out, the whole board is on screen, so frustum culling saves nothing.
  expect(far.triangles).toBeLessThan(near.triangles * 0.6);
  expect(back.triangles).toBe(near.triangles);
  console.log("Triangles by tier:", { near: near.triangles, far: far.triangles });
});

test("the drone view looks straight down with north up, places tiles and is remembered", async ({ page }) => {
  await ready(page);
  const overhead = async () => {
    const [x, , z] = await page.evaluate(() => window.tabletopTest.stats().camera);
    const [tx, , tz] = await page.evaluate(() => window.tabletopTest.cameraTarget());
    return Math.hypot(x - tx, z - tz);
  };
  expect(await overhead()).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Drone" }).click();
  await expect.poll(overhead).toBeLessThan(0.01);
  const up = await page.evaluate(() => window.tabletopTest.cameraUp());
  expect(up[2]).toBeCloseTo(-1, 5);
  const point = await legalPoint(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("tile-count")).toHaveText("2");
  await page.screenshot({ path: "test-results/tabletop-drone.png" });

  await page.reload();
  await sceneReady(page);
  await expect(page.getByRole("button", { name: "Drone" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(overhead).toBeLessThan(0.01);
  await page.getByRole("button", { name: "Tabletop" }).click();
  await expect.poll(overhead).toBeGreaterThan(1);
});

test("the production game keeps its current tile when switching camera views", async ({ page }) => {
  await page.goto("/");
  // Screenshots are compared below, so keep the water still.
  await page.evaluate(() => localStorage.setItem("american-tile-trails.extra-vfx", "off"));
  await page.reload();
  await page.getByRole("button", { name: "Start Game" }).click();
  await expect(page.getByTestId("board-3d")).toBeVisible();
  const name = await page.locator(".tabletop-tile-preview").getAttribute("aria-label");
  await page.getByRole("button", { name: "Drone" }).click();
  await expect(page.getByRole("button", { name: "Drone" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("board-3d")).toBeVisible();
  await page.getByRole("button", { name: "Tabletop" }).click();
  await expect(page.locator(".tabletop-tile-preview")).toHaveAttribute("aria-label", name!);
  await page.waitForTimeout(300);
  const preview = page.locator(".tabletop-tile-preview canvas");
  const original = await preview.screenshot();
  await page.getByTitle("Rotate clockwise (E)", { exact: true }).click();
  await expect.poll(async () => (await preview.screenshot()).equals(original)).toBe(false);
  await page.getByTitle("Rotate counter-clockwise (Q)", { exact: true }).click();
  await expect.poll(async () => (await preview.screenshot()).equals(original)).toBe(true);
  await page.keyboard.press("e");
  await expect.poll(async () => (await preview.screenshot()).equals(original)).toBe(false);
  await page.keyboard.press("q");
  await expect.poll(async () => (await preview.screenshot()).equals(original)).toBe(true);
  await page.screenshot({
    path: "test-results/tabletop-game.png",
    fullPage: true,
  });
});

test("night mode switches the board and HUD, and persists", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("american-tile-trails.time", "day");
    // Only the switch to night should change the image, not moving water.
    localStorage.setItem("american-tile-trails.extra-vfx", "off");
  });
  await page.reload();
  await page.getByRole("button", { name: "Start Game" }).click();
  await expect(page.getByTestId("board-3d")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-time", "day");
  const canvas = page.locator('[data-testid="board-3d"] canvas');
  await page.waitForTimeout(500);
  const day = await canvas.screenshot();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Night" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-time", "night");
  await expect.poll(async () => (await canvas.screenshot()).equals(day)).toBe(false);
  await page.screenshot({ path: "test-results/tabletop-night.png" });
  await page.keyboard.press("n");
  await expect(page.locator("html")).toHaveAttribute("data-time", "day");
  await page.keyboard.press("n");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-time", "night");
  await expect(page.getByRole("button", { name: "Switch to day" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a whole turn can be played from the keyboard", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Start Game" }).click();
  await expect(page.getByTestId("board-3d")).toBeVisible();
  await expect(page.getByText("0/62 tiles")).toBeVisible();
  const status = page.locator(".board-pill-status");
  // Rotate with E until the tile fits somewhere.
  for (let turn = 0; turn < 4; turn++) {
    if (/\b[1-9]\d* places? to build/.test((await status.textContent()) ?? "")) break;
    await page.keyboard.press("e");
    await page.waitForTimeout(100);
  }
  await expect(status).toContainText(/\b[1-9]\d* places? to build/);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByText("1/62 tiles")).toBeVisible();
  // Claim with the keyboard if offered, otherwise the turn has already passed.
  if (await page.getByText("Claim a feature").isVisible()) await page.keyboard.press("x");
  await expect(page.getByText(/Waiting for|Thinking/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("camera keys zoom, pan and fit the board", async ({ page }) => {
  await ready(page);
  const stats = () => page.evaluate(() => window.tabletopTest.stats());
  const fitted = await stats();
  await page.keyboard.press("+");
  await expect.poll(async () => (await stats()).zoom).toBeGreaterThan(fitted.zoom * 1.1);
  await page.keyboard.press("-");
  await page.keyboard.press("-");
  await expect.poll(async () => (await stats()).zoom).toBeLessThan(fitted.zoom * 0.9);
  const before = await stats();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await stats()).camera[0]).not.toBeCloseTo(before.camera[0], 3);
  await page.keyboard.press("f");
  await expect.poll(async () => (await stats()).zoom).toBeCloseTo(fitted.zoom, 3);
  await expect.poll(async () => (await stats()).camera[0]).toBeCloseTo(fitted.camera[0], 3);
});

test("a placed tile drops in, raises dust, lands, and rendering goes idle", async ({ page }, testInfo) => {
  await ready(page);
  const point = await legalPoint(page);
  const target = (await page.evaluate(() => window.tabletopTest.state().legal))[0];
  const before = await page.evaluate(() => window.tabletopTest.stats().frame);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("tile-count")).toHaveText("2");
  // Early in the fall the tile is drawn above the table.
  await expect.poll(() => page.evaluate((p) => window.tabletopTest.tileHeight(p), target)).toBeGreaterThan(0.05);
  await expect.poll(() => page.evaluate(() => window.tabletopTest.dustVisible())).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("landing-dust.png") });
  // It lands exactly on the table, and demand rendering stops.
  await expect.poll(() => page.evaluate((p) => window.tabletopTest.tileHeight(p), target), { timeout: 3000 }).toBe(0);
  await expect.poll(() => page.evaluate(() => window.tabletopTest.dustVisible())).toBe(false);
  const settled = await page.evaluate(() => window.tabletopTest.stats().frame);
  expect(settled - before).toBeGreaterThan(5);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.tabletopTest.stats().frame)).toBe(settled);
});

test("reduced motion places tiles without the landing animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  const point = await legalPoint(page);
  const target = (await page.evaluate(() => window.tabletopTest.state().legal))[0];
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("tile-count")).toHaveText("2");
  for (let i = 0; i < 5; i++) {
    expect(await page.evaluate((p) => window.tabletopTest.tileHeight(p), target)).toBe(0);
    expect(await page.evaluate(() => window.tabletopTest.dustVisible())).toBe(false);
    await page.waitForTimeout(60);
  }
});

test("a Costco tile's warehouse falls with it, then joins its neighbours", async ({ page }) => {
  await ready(page);
  // Play turns until a Costco tile comes up.
  for (
    let turn = 0;
    turn < 12 && !/costco/.test((await page.evaluate(() => window.tabletopTest.state())).tileId ?? "");
    turn++
  ) {
    const point = await legalPoint(page);
    const count = await page.evaluate(() => window.tabletopTest.state().count);
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => page.evaluate(() => window.tabletopTest.state().count)).toBe(count + 1);
    if ((await page.evaluate(() => window.tabletopTest.state().phase)) === "claim_feature")
      await page.getByRole("button", { name: "Skip claim" }).click();
    await expect.poll(() => page.evaluate(() => window.tabletopTest.landingWarehouseHeight())).toBeNull();
  }
  expect((await page.evaluate(() => window.tabletopTest.state())).tileId).toMatch(/costco/);
  const point = await legalPoint(page);
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.tabletopTest.landingWarehouseHeight())).toBeGreaterThan(0.1);
  await expect
    .poll(() => page.evaluate(() => window.tabletopTest.landingWarehouseHeight()), { timeout: 3000 })
    .toBeNull();
});
