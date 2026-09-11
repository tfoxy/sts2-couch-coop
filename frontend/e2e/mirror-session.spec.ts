import { expect, test, type Page } from "@playwright/test";

import { DIRECT_WS_QUERY, LOBBY_BASE_URL } from "./ports";

// The shared JOIN behavior, mirror-mounted.
//
// These legs used to live in a structured-view suite (e2e/session.spec.ts + the unaffiliated leg of
// e2e/qr.spec.ts). None of what they cover was structured-specific: name memory, `?name=` auto-join, two
// devices sharing one seat, a seat that is already controlled, the URL write-back, the lobby-only reap and the
// disconnected roster are the JOIN PROTOCOL, and the mirror is now the only client that speaks it. They are
// ported here rather than deleted with the view that happened to host them.
//
// WHAT IS OBSERVABLE HERE, and why the assertions are shaped the way they are. The harness
// (tests/CouchCoop.HostedServerHarness) runs the REAL CouchCoopBrowserServer over a fake runtime with no
// headless manager, so a join for a seat is answered `joinRejection: "not-a-session-player"` — the roster
// bookkeeping is real, the seat hand-off is not. That is exactly the half these tests are about: every leg
// below asserts the SERVER'S roster (identity, controller count, membership) read back off a second socket,
// which is the same roster data the retired structured-client suite asserted on. The one join this harness
// does complete is the HOST's (`directView`), so the URL write-back leg uses that.
//
// WHICH NAMES WORK, which is not a free choice. The run harness's roster IS its run — "Alice", "Bob", "Host" —
// and a name that is not in it creates no row at all (the host has no seat to record), so the counted legs on
// that harness must use Alice/Bob. They are this file's alone: `e2e/smoke.spec.ts` joins as "Host" on the same
// shared harness and `fullyParallel` overlaps the workers, so no leg here may assert a COUNT on "Host". The
// LOBBY harness is the opposite — a new name there becomes a real lobby-only row, which is what makes the reap
// and unaffiliated-join legs below testable.
//
// Serial within the file, and each counted leg waits for its seat to be BACK AT ZERO before it starts: a
// closing context releases its controller asynchronously, so without that precondition a leg could read the
// previous leg's tail and pass on a stale number.

const LAST_PLAYER_NAME_STORAGE_KEY = "couchCoop:lastPlayerName";

test.describe.configure({ mode: "serial" });

test.beforeEach(({ }, testInfo) => {
  test.skip(testInfo.project.name !== "smoke", "the join protocol is covered once, not per viewport");
});

test("?name= joins on connect, with no tap", async ({ page }) => {
  await idleSeat("Alice");

  await page.goto("/?name=Alice");
  await expect(page.getByTestId("mirror-surface")).toBeVisible();

  // The auto-join fired without the picker being touched: the host knows this device by that name, and nothing
  // was tapped to make that happen.
  await expect.poll(() => controllersFor(rosterUrl(), "Alice")).toBe(1);
  // The round trip COMPLETED — this harness cannot hand out the seat, and says so. What matters here is that
  // the answer lands as a message on the picker rather than as a spinner nobody ever resolves.
  await expect(page.getByTestId("mirror-join-message")).toBeVisible();
  // …and the URL still names the seat, so a reload re-claims it rather than landing anonymous.
  expect(new URL(page.url()).searchParams.get("name")).toBe("Alice");
});

test("two tabs share one seat and the controller count follows", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  const second = await context.newPage();

  await idleSeat("Bob");

  await first.goto("/?name=Bob");
  await expect.poll(() => controllersFor(rosterUrl(), "Bob")).toBe(1);

  await second.goto("/?name=Bob");
  // ONE seat, two controllers — not two seats. Both halves matter: a second row would mean the host had
  // invented a player for the second device instead of seating it beside the first.
  await expect.poll(() => controllersFor(rosterUrl(), "Bob")).toBe(2);
  await expect.poll(() => rowsNamed(rosterUrl(), "Bob")).toBe(1);

  await context.close();
});

test("joining an already-controlled seat leaves it with the first browser", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  await idleSeat("Alice");

  await first.goto("/?name=Alice");
  await expect.poll(() => controllersFor(rosterUrl(), "Alice")).toBe(1);

  // A DIFFERENT device (its own context, so its own storage) asks for the same seat.
  await second.goto("/?name=Alice");
  await expect.poll(() => controllersFor(rosterUrl(), "Alice")).toBe(2);

  // The first browser was not displaced: closing the SECOND returns the seat to exactly one controller
  // rather than to none, which is what a hand-over would have left behind.
  await secondContext.close();
  await expect.poll(() => controllersFor(rosterUrl(), "Alice")).toBe(1);

  await firstContext.close();
});

test("joining from the picker writes the seat back into the URL", async ({ page }) => {
  await page.goto("/");

  // The host row is the one join this harness completes (`directView` — watch the host's own stream), so it is
  // what proves the write-back path end to end. Its marker is an EMPTY `?name=`: this tab is a watcher on the
  // host's view, not a seat holder, and the empty value is what a reload reads to return here instead of
  // landing on the picker again.
  await expect(page.getByTestId("player-picker")).toBeVisible();
  await hostChoice(page).click();

  await expect.poll(() => new URL(page.url()).searchParams.has("name")).toBe(true);
  expect(new URL(page.url()).searchParams.get("name")).toBe("");
  // Joined ⇒ the picker is gone; the viewer is watching, not choosing.
  await expect(page.getByTestId("player-picker")).toHaveCount(0);
  await expect(page.getByTestId("join-form")).toHaveCount(0);
});

test("a lobby-only player is removed after their last browser closes", async ({ browser }) => {
  const context = await browser.newContext();
  const joined = await context.newPage();

  await joined.goto(`${LOBBY_BASE_URL}/?name=MirrorReaped`);
  // A name the lobby has never seen becomes a real row — that is what "joining a lobby" IS.
  await expect.poll(() => rowsNamed(`${LOBBY_BASE_URL}/ws`, "MirrorReaped")).toBe(1);

  await context.close();

  // Nobody is holding it and there is no run to hold it FOR, so the row goes — otherwise every reload of every
  // phone would silt the lobby up with ghosts.
  await expect.poll(() => rowsNamed(`${LOBBY_BASE_URL}/ws`, "MirrorReaped")).toBe(0);
});

test("a run seat reads as disconnected once its last browser closes", async ({ browser }) => {
  const context = await browser.newContext();
  const joined = await context.newPage();

  await idleSeat("Bob");

  await joined.goto("/?name=Bob");
  await expect.poll(() => seatFor(rosterUrl(), "Bob"))
    .toEqual({ connectionCount: 1, disconnected: false });

  await context.close();

  // A run seat is NOT reaped — the run still has that player, they just have nobody driving them. That is the
  // state a returning device is looking for, and the flag the picker highlights it from.
  await expect.poll(() => seatFor(rosterUrl(), "Bob"))
    .toEqual({ connectionCount: 0, disconnected: true });
});

test("an uncontrolled roster row carries its state without wording it as a fault", async ({ page }) => {
  await page.goto("/");

  const host = hostChoice(page);
  await expect(host).toBeVisible();
  // The state rides the element (that IS the picker's contract for tooling); the WORDS "0 controllers" must
  // not, because they read as a fault on a row that is perfectly joinable — the highlight already carries the
  // state. See joinModel.shouldShowConnectionCount (native twin: JoinModel.ShouldShowConnectionCount).
  await expect(host).toHaveAttribute("data-connection-count", /^\d+$/);
  await expect(host).toHaveAttribute("data-disconnected", /^(true|false)$/);
  await expect(host.getByTestId("connection-count")).toHaveCount(0);
  await expect(host).not.toContainText("controller");
});

test("a bare QR URL lands unaffiliated and joins through the normal session protocol", async ({ page }) => {
  await page.goto(`${LOBBY_BASE_URL}/`);

  // Nothing is assumed about who this is: no name, no remembered name, no credential of any kind. The QR code
  // is a pointer to a host, never an identity.
  await expect(page).toHaveURL(`${LOBBY_BASE_URL}/`);
  await expect(page.getByTestId("join-name-input")).toBeFocused();
  await expect(page.getByTestId("join-name-input")).toHaveValue("");
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), LAST_PLAYER_NAME_STORAGE_KEY))
    .toBeNull();
  const credentialKeys = await page.evaluate(() =>
    Object.keys(sessionStorage).concat(Object.keys(localStorage)).filter((key) => /auth|trust|token/i.test(key)));
  expect(credentialKeys).toEqual([]);

  await page.getByTestId("join-name-input").fill("MirrorQr");
  await page.getByTestId("join-submit").click();

  // The submit reaches the host through the ordinary join protocol…
  await expect.poll(() => rowsNamed(`${LOBBY_BASE_URL}/ws`, "MirrorQr")).toBe(1);
  // …and a name this harness cannot seat comes back as a MESSAGE, not as a spinner that never ends.
  await expect(page.getByTestId("mirror-join-message")).toBeVisible();
});

/**
 * Wait for a run seat to have no controller on it.
 *
 * A closed browser context releases its socket asynchronously, so a leg that starts by asserting `toBe(1)`
 * could otherwise be satisfied by the PREVIOUS leg's controller and never notice its own join failed.
 */
async function idleSeat(name: string): Promise<void> {
  await expect.poll(() => controllersFor(rosterUrl(), name)).toBe(0);
}

function hostChoice(page: Page) {
  return page.getByTestId("player-picker").getByRole("button", { name: /^Host\b/ });
}

function rosterUrl(): string {
  // The run harness — `baseURL`, and therefore what a bare `page.goto("/")` above talks to.
  return directWebSocketUrl(test.info().project.use.baseURL ?? "http://127.0.0.1:23337");
}

function directWebSocketUrl(origin: string): string {
  const url = new URL("/ws", origin);
  url.search = DIRECT_WS_QUERY;
  return url.toString();
}

interface RosterPlayer {
  name?: string;
  connectionCount?: number;
  disconnected?: boolean;
}

/**
 * The host's CURRENT roster, read off a fresh socket.
 *
 * This is a plain observer: it never sends `join`, so opening it moves no player's controller count. Waits for
 * the `session` frame specifically rather than taking the first message, so it does not depend on which other
 * frames a given host build happens to push on connect.
 */
async function roster(wsUrl: string): Promise<RosterPlayer[]> {
  const url = new URL(directWebSocketUrl(wsUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.toString());
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for a session frame from the harness."));
    }, 5000);

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; players?: RosterPlayer[] };
      if (message.type !== "session") return;
      clearTimeout(timer);
      socket.close();
      resolve(message.players ?? []);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Harness WebSocket failed."));
    });
  });
}

async function rowsNamed(wsUrl: string, name: string): Promise<number> {
  return roster(wsUrl).then((players) => players.filter((player) => player.name === name).length);
}

async function controllersFor(wsUrl: string, name: string): Promise<number | null> {
  return roster(wsUrl).then((players) =>
    players.find((player) => player.name === name)?.connectionCount ?? null);
}

async function seatFor(wsUrl: string, name: string): Promise<RosterPlayer | null> {
  return roster(wsUrl).then((players) => {
    const player = players.find((entry) => entry.name === name);
    return player
      ? { connectionCount: player.connectionCount, disconnected: player.disconnected }
      : null;
  });
}
