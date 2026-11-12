// The wall in a real browser (ADR 0011): Chromium through Playwright, signed in to the real stack,
// with pipes opened by the real CLI to real local HTTP servers. The network runs its reduced-motion
// path (nodes hold still), so a press lands where the pill is rather than where it drifted from.
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  api,
  cli,
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

  it("puts Create pipe back where it stood, in the first frame it shows after its card closes", async () => {
    // With motion on: the frame loop then rests between drift ticks instead of holding still.
    const moving = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState: await context.storageState(),
    });

    const wall = await moving.newPage();

    try {
      await wall.goto(`${stack.url}/`);
      const button = wall.locator("[data-create]:not([inert] *)");
      await expect.poll(() => button.isVisible()).toBe(true);
      const rest = (await button.boundingBox())!;
      // The live button (not the card's inert copy) in a colour nothing else on the wall uses.
      await wall.addStyleTag({
        content: "[data-create]:not([inert] *) { background: rgb(255 0 255) !important; }",
      });
      await button.click();
      await expect.poll(() => wall.locator("section[data-open]").isVisible()).toBe(true);
      await wall.waitForTimeout(500);
      // Every frame the browser paints, as it painted it.
      const cdp = await moving.newCDPSession(wall);
      const frames: string[] = [];
      cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
        frames.push(data);
        void cdp.send("Page.screencastFrameAck", { sessionId });
      });
      await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      await wall.keyboard.press("Escape");
      await expect.poll(() => wall.locator("section[data-open]").count()).toBe(0);
      await wall.waitForTimeout(400);
      await cdp.send("Page.stopScreencast");
      // Where the magenta is in each frame, decoded by the browser itself.
      const reader = await moving.newPage();

      const boxes = await reader.evaluate(async (pngs) => {
        const found: { x: number; y: number }[] = [];

        for (const png of pngs) {
          const image = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${png}`)).blob(),
          );

          const canvas = new OffscreenCanvas(image.width, image.height);
          const g = canvas.getContext("2d")!;
          g.drawImage(image, 0, 0);
          const { data, width } = g.getImageData(0, 0, image.width, image.height);
          let [x, y] = [Infinity, Infinity];

          for (let i = 0; i < data.length; i += 4) {
            if (data[i]! > 240 && data[i + 1]! < 20 && data[i + 2]! > 240) {
              x = Math.min(x, (i / 4) % width);
              y = Math.min(y, Math.floor(i / 4 / width));
            }
          }

          if (x !== Infinity) found.push({ x, y });
        }

        return found;
      }, frames);

      expect(boxes.length).toBeGreaterThan(0);

      // Catches: the button painted at the closed card's corner (the flicker) until the frame
      // loop's next idle tick moves it home. Drift moves it a couple of pixels at most.
      for (const at of boxes) expect(Math.hypot(at.x - rest.x, at.y - rest.y)).toBeLessThan(4);
    } finally {
      await moving.close();
    }
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
    // Its own pill stays under the card, inert, as the corner it unfolds from.
    await expect
      .poll(async () => {
        const c = (await card.boundingBox())!;

        const others = await page
          .locator(`[data-pipe]:not([data-pipe="${opened}"]), [data-create]`)
          .evaluateAll((els) =>
            els.map((el) => {
              const { x, y, width, height } = el.getBoundingClientRect();

              return { x, y, width, height };
            }),
          );

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

  it("creates a pipe from this computer: one copied command, no token, no approval, then its ports and the picked one opens", async () => {
    const local = await localServer((_req, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end("<title>From this computer</title>"),
    );

    servers.push(local);
    await page.locator("[data-create]").click();
    await page.getByRole("menuitem", { name: "Create from this computer" }).click();
    const card = page.locator("section[data-open]");

    const run = card.getByRole("button", {
      name: /^Copy run: npx wurmhol@latest host --code \S+$/,
    });

    // Catches: the steps opening without the command to run, or in a card of another size. The
    // command waits on the card's setup-code request, as the pills wait on the wall's feed.
    await expect.poll(() => run.count(), { timeout: 5000 }).toBe(1);
    expect((await card.boundingBox())!.width).toBe((await card.boundingBox())!.height);
    // Catches: a card still asking to approve a link in the terminal.
    expect(await card.textContent()).not.toContain("Approve");
    await run.click();
    const command = await page.evaluate(() => navigator.clipboard.readText());
    const [npx, binary, ...args] = command.split(" ");
    expect([npx, binary, args[0], args[1]]).toEqual(["npx", "wurmhol@latest", "host", "--code"]);

    // A computer that has never logged in: no WURMHOL_TOKEN, nothing saved.
    const fresh: Record<string, string> = cliEnv(stack, "");
    delete fresh.WURMHOL_TOKEN;
    let said = "";

    const host = spawn(process.execPath, [cliPath, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...fresh },
      stdio: ["ignore", "pipe", "pipe"],
    });

    host.stdout!.on("data", (chunk: Buffer) => (said += chunk));
    host.stderr!.on("data", (chunk: Buffer) => (said += chunk));

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
      // Catches: the CLI printing a device-code prompt to approve instead of logging straight in.
      expect(said).not.toContain("and enter");
      expect(said).toContain(`as ${hostname()}`);
      await stopAll(fresh);
    } finally {
      host.kill();
    }

    // Catches: a setup code that logs in a second computer (it is single use), or a refusal that
    // does not say where to get a new one.
    const reused = await cli(args, fresh);
    expect(reused.code).toBe(1);
    expect(reused.stderr).toContain("Copy the command again from Create pipe");

    // Catches: the token named after something other than the computer, or owned by no one.
    const { body } = await api(
      stack,
      ada,
      "/api/tokens",
      {},
      z.object({ tokens: z.array(z.object({ name: z.string(), source: z.string() })) }),
    );

    expect(body.tokens.filter((t) => t.name === hostname() && t.source === "login")).toHaveLength(
      1,
    );
  });
});
