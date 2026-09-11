import { expect, test } from "@playwright/test";

import { DIRECT_WS_QUERY } from "./ports";

test("smoke loads the SPA shell at /", async ({ page }) => {
  await page.goto("/");
  // The mirror is the only client, and it owns the surface: its root carries the shared `.game-surface`
  // chrome class under its OWN `mirror-surface` testid, so there is no second surface to find.
  await expect(page.getByTestId("mirror-surface")).toBeVisible();
  await expect(page.getByTestId("game-surface")).toHaveCount(0);
});

test("smoke falls back to the SPA shell for deep links", async ({ page }) => {
  await page.goto("/some/deep/link");
  await expect(page.locator("base")).toHaveAttribute("href", "/");
  await expect(page.getByTestId("mirror-surface")).toBeVisible();
});

test("smoke preserves join URL usability with query params", async ({ page }) => {
  await page.goto("/?name=Host");
  await expect(page).toHaveURL(/name=Host/);
  await expect(page.getByTestId("mirror-surface")).toBeVisible();
});

test("smoke can connect to /ws", async ({ page }) => {
  await page.goto("/");
  // The required capability query carries no identity: every socket connects anonymously, and identity is
  // established only by an explicit `join` message.
  const messages = await page.evaluate(async (directWsQuery) => {
    const wsUrl = new URL("/ws", window.location.href);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.search = directWsQuery;

    return await new Promise<string[]>((resolve, reject) => {
      const received: string[] = [];
      const socket = new WebSocket(wsUrl);
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error("Timed out waiting for websocket session replies."));
      }, 5_000);

      socket.addEventListener("message", (event) => {
        const payload = String(event.data);
        const parsed = JSON.parse(payload) as { type?: string };
        if (parsed.type !== "session") {
          return; // Identity rides `session`; anything else on this socket is not it.
        }

        received.push(payload);
        if (received.length === 1) {
          // The full browser payload must be harmless in the Godot-less HostedServerHarness. The subsequent join
          // reply proves this control message was consumed rather than faulting the receive loop.
          socket.send(JSON.stringify({
            type: "settings",
            requestId: "e2e:smoke-settings",
            refreshRate: 30,
            freezeParticles: false,
            freezeSpines: false,
            freezeDecor: false,
            tweenReplay: true,
            staticBg: false,
            trailDrive: false
          }));
          socket.send(JSON.stringify({ type: "join", requestId: "e2e:smoke-join", name: "Host" }));
          return;
        }

        if (parsed.session?.joined !== true) {
          return;
        }

        window.clearTimeout(timeout);
        socket.close();
        resolve(received);
      });
      socket.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("WebSocket connection failed."));
      });
    });
  }, DIRECT_WS_QUERY);

  const parsedMessages = messages.map((message) => JSON.parse(message) as {
    type?: string;
    session?: { joined?: boolean };
  });

  expect(parsedMessages[0]).toMatchObject({
    type: "session",
    session: {
      joined: false
    }
  });

  const joinedMessage = parsedMessages.find((message) => message.type === "session" && message.session?.joined === true);
  expect(joinedMessage).toMatchObject({
    type: "session",
    session: {
      joined: true
    }
  });
});

test("smoke sizes the game surface at 16:9", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "smoke", "Viewport projects cover visual-policy sizing.");

  await page.goto("/");
  const viewport = page.viewportSize();
  const box = await page.getByTestId("mirror-surface").boundingBox();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.width).toBe(viewport!.width);
  expect(box!.height).toBe(viewport!.height);
  expect(box!.width / box!.height).toBeCloseTo(16 / 9, 2);
});
