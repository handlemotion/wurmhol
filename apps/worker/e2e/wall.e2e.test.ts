// The wall in a real browser (ADR 0011): Chromium through Playwright, signed in to the real stack,
// with pipes opened by the real CLI to real local HTTP servers. The network runs its reduced-motion
// path (nodes hold still), so a press lands where the pill is rather than where it drifted from.
import { spawn } from "node:child_process";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cliEnv,
  cliPath,
  createToken,
  localServer,
  type Person,
  share,
  signIn,
  type Stack,
  startStack,
  stopAll,
  waitFor,
} from "./support.ts";

describe("the wall in a browser", () => {
  let stack: Stack;
  let ada: Person;
  let env: Record<string, string>;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const servers: { close: () => Promise<void> }[] = [];

  /** A real dev server with a title, shared by the real CLI. */
  async function openPipe(title: string) {
    const local = await localServer((_req, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end(`<title>${title}</title>`),
    );
    servers.push(local);
    return share(stack, env, local.port);
  }

  beforeAll(async () => {
    stack = await startStack();
    ada = await signIn(stack);
    env = cliEnv(stack, (await createToken(stack, ada)).token);
    browser = await chromium.launch();
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: stack.url });
    // The session's `__Host-` cookies: Secure, Path=/, no Domain (browsers allow Secure on localhost).
    await context.addCookies(
      ada.cookie.split("; ").map((pair) => {
        const at = pair.indexOf("=");
        const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
        return { name, value, domain: "localhost", path: "/", secure: true, sameSite: "Lax" };
      }),
    );
    page = await context.newPage();
    await page.goto(`${stack.url}/`);
    // Loaded: while the skeleton shows, skullet renders a covered copy of the network too.
    await waitFor(async () => (await page.locator("[data-create]").count()) === 1, {
      what: "the wall, loaded",
    });
  });

  afterAll(async () => {
    await browser?.close();
    await stopAll(env);
    await Promise.all(servers.map((server) => server.close()));
    await stack.stop();
  });

  it("shows a new pipe live, opens its card on a press, and closes it on an outside press and on Escape", async () => {
    const started = await openPipe("Wall browser test");
    const pill = page.locator(`[data-pipe="${started.id}"]`);
    // Catches: the wall missing share.started, so a pipe shows only after a reload.
    await expect.poll(() => pill.isVisible(), { timeout: 5000 }).toBe(true);

    await pill.click();
    const card = page.locator("section[data-open]");
    // Catches: a press on a pill that no longer opens its card, or opens it without its URL.
    await expect.poll(() => card.isVisible()).toBe(true);
    expect(await card.getByRole("button", { name: `Copy url: ${started.url}` }).count()).toBe(1);

    // A press on empty canvas, away from every node.
    await page.mouse.click(8, 792);
    // Catches: the outside-press listener dropping, leaving the card stuck open.
    await expect.poll(() => card.count()).toBe(0);
    // Catches: focus lost to <body> on close, so a keyboard user starts over from the top.
    await expect.poll(() => pill.evaluate((el) => el === document.activeElement)).toBe(true);

    await page.keyboard.press("Enter");
    await expect.poll(() => card.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    // Catches: Escape not closing the card, or closing it without handing focus back.
    await expect.poll(() => card.count()).toBe(0);
    await expect.poll(() => pill.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  it("copies each way to start a pipe from Create pipe", async () => {
    await page.locator("[data-create]").click();
    const rows: [string, string][] = [
      [
        "Copy agent prompt",
        "Start the dev server, then run `npx wurmhol <port>` with its port and send me the URL it prints.",
      ],
      ["Copy npx command", "npx wurmhol <port>"],
    ];
    for (const [label, text] of rows) {
      await page.getByRole("menuitem", { name: label }).click();
      // Catches: a row copying another row's text, or nothing reaching the clipboard.
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()), { message: label })
        .toBe(text);
    }
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("[data-create]").isVisible()).toBe(true);
  });

  it("removes a pipe live when its card's Terminate is pressed", async () => {
    const started = await openPipe("Terminate me");
    const pill = page.locator(`[data-pipe="${started.id}"]`);
    await expect.poll(() => pill.isVisible(), { timeout: 5000 }).toBe(true);
    await pill.click();
    // The pressed pill turns into the card, so watch the card, then check the pill stays gone.
    const card = page.locator("section[data-open]");
    await expect.poll(() => card.isVisible()).toBe(true);
    await card.getByRole("button", { name: "Terminate" }).click();
    // Catches: Terminate ending the pipe while the wall keeps showing its card or its pill.
    await expect.poll(() => card.count(), { timeout: 5000 }).toBe(0);
    expect(await pill.count()).toBe(0);
    expect(await page.locator("[data-pipe]").count()).toBe(1);
  });

  it("lights one fill, on the row under the pointer, as it moves between Create pipe's rows", async () => {
    await page.locator("[data-create]").click();
    const rows = page.getByRole("menuitem");
    const fill = page.locator("[data-slot=fluid-hover-highlight]");
    for (const label of ["Copy agent prompt", "Copy npx command", "Copy agent prompt"]) {
      const row = page.getByRole("menuitem", { name: label });
      const box = (await row.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // Catches: the fill handed back to the row hovered before (the flicker), or two fills.
      await expect
        .poll(
          async () => {
            const lit = await fill.boundingBox();
            return (await fill.count()) === 1 && lit !== null && Math.abs(lit.y - box.y) < 1;
          },
          { message: label },
        )
        .toBe(true);
    }
    // Catches: a row painting a fill of its own beside the moving one.
    const fills = await rows.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor),
    );
    expect(fills.every((fill) => fill === "rgba(0, 0, 0, 0)")).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("[data-create]").isVisible()).toBe(true);
  });

  it("opens a card where its pill stands, moves the pills it would cover, and pans it to the middle", async () => {
    await openPipe("Second pipe");
    await openPipe("Third pipe");
    const pills = page.locator("[data-pipe]");
    await expect.poll(() => pills.count(), { timeout: 5000 }).toBe(3);
    const ids = await pills.evaluateAll((els) => els.map((el) => el.getAttribute("data-pipe")!));
    const centre = async (id: string) => {
      const box = (await page.locator(`[data-pipe="${id}"]`).boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const opened = ids[0]!;
    const before = await centre(ids[1]!);

    await page.locator(`[data-pipe="${opened}"]`).click();
    const card = page.locator("section[data-open]");
    await expect.poll(() => card.isVisible()).toBe(true);
    // Catches: the card opening over its neighbours instead of the pills it covers stepping aside.
    await expect
      .poll(async () => {
        const c = (await card.boundingBox())!;
        const others = await page
          .locator("[data-pipe], [data-create]")
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
        return others.filter(
          (o) =>
            o.x < c.x + c.width &&
            c.x < o.x + o.width &&
            o.y < c.y + c.height &&
            c.y < o.y + o.height,
        ).length;
      })
      .toBe(0);

    // Catches: the camera not panning, leaving the card where it opened (half off-screen).
    const box = (await card.boundingBox())!;
    const view = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(2);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);

    await page.keyboard.press("Escape");
    await expect.poll(() => card.count()).toBe(0);
    // Catches: the camera staying panned, or a pushed pill not returning, after the card closes.
    await expect
      .poll(async () => {
        const back = await centre(ids[1]!);
        return Math.hypot(back.x - before.x, back.y - before.y) < 1.5;
      })
      .toBe(true);
  });

  it("creates a pipe from this computer: shows the steps, then the ports it serves, and opens the picked one", async () => {
    const local = await localServer((_req, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end("<title>From this computer</title>"),
    );
    servers.push(local);
    await page.locator("[data-create]").click();
    await page.getByRole("menuitem", { name: "Create from this computer" }).click();
    const card = page.locator("section[data-open]");
    // Catches: the steps opening without the command to run, or in a card of another size.
    await expect
      .poll(() => card.getByRole("button", { name: "Copy run: npx wurmhol host" }).count())
      .toBe(1);
    expect((await card.boundingBox())!.width).toBe((await card.boundingBox())!.height);

    const host = spawn(process.execPath, [cliPath, "host"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: "ignore",
    });
    try {
      const row = card.getByRole("menuitem", { name: new RegExp(`:${local.port}`) });
      // Catches: the card not hearing that the computer connected, or its ports.
      await expect.poll(() => row.isVisible(), { timeout: 15_000 }).toBe(true);
      expect(await row.textContent()).toContain("From this computer");
      await row.click();
      // Catches: a pick that opens nothing, or a pipe whose card never opens on the wall in
      // place of Create pipe.
      await expect
        .poll(async () => (await card.count()) === 1 && (await card.textContent()), {
          timeout: 15_000,
        })
        .toContain("Terminate");
      expect(await card.textContent()).toContain("From this computer");

      await page.keyboard.press("Escape");
      await page.locator("[data-create]").click();
      await page.getByRole("menuitem", { name: "Create from this computer" }).click();
      await card.getByRole("button", { name: "Back" }).click();
      // Catches: Back leaving the steps on screen instead of the ways to start a pipe.
      await expect
        .poll(() => page.getByRole("menuitem", { name: "Copy agent prompt" }).isVisible())
        .toBe(true);
      await page.keyboard.press("Escape");
    } finally {
      host.kill();
    }
  });
});
