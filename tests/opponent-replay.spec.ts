import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { Chess, type Color } from "chess.js";

const replayName = "Replay opponent's last move";

function gameFromMoves(moves: string[]) {
  const chess = new Chess();
  const history = moves.map((san, index) => {
    const move = chess.move(san);
    return { from: move.from, to: move.to, san: move.san, by: move.color === "w" ? "white" : "black", at: index + 1, fen: move.after };
  });
  return {
    id: "replay-game", whiteId: "white", blackId: "black",
    whiteHandle: "alice", blackHandle: "bob", timeControl: "10|0",
    fen: chess.fen(), moves: history, turn: chess.turn(),
    status: chess.isCheckmate() ? "checkmate" : "active",
    whiteMs: 600_000, blackMs: 600_000, lastTickAt: Date.now(),
    connectionState: { white: "connected", black: "connected" }, callSession: null,
  };
}

async function openFixture(page: Page, moves: string[], color: Color = "w") {
  let game = gameFromMoves(moves);
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Production analytics rejects localhost in WebKit; replay fixtures do not send telemetry.
  await page.route("https://static.cloudflareinsights.com/beacon.min.js", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/games/*/socket", (socket) => {
    sockets.push(socket);
    socket.onMessage((message) => {
      if (message === "ping") socket.send("pong");
      if (message === "sync") socket.send(JSON.stringify({ game }));
    });
  });
  const home = {
    user: { id: color === "w" ? "white" : "black", handle: color === "w" ? "alice" : "bob", inviteToken: "test" },
    inviteUrl: "/", friends: [], requests: [], sentRequests: [], challenges: [], sentChallenges: [], schedules: [], games: [], pushTypes: [], pushPublicKey: "",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/games/") && route.request().method() !== "GET") writes.push(path);
    await route.fulfill({ json: path.endsWith("/state") ? game : home });
  });
  await page.goto("/game/replay-game");
  await expect(page.getByRole("grid", { name: "Chess board" })).toBeVisible();
  await expect(page.getByRole("status", { name: "opponent connected" })).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  return {
    get game() { return game; }, writes, errors,
    async publish(nextMoves: string[], status?: string) {
      game = gameFromMoves(nextMoves);
      if (status) game.status = status;
      sockets.forEach((socket) => socket.send(JSON.stringify({ game })));
      await expect(page.getByRole("grid")).not.toHaveAttribute("aria-busy", "true");
    },
  };
}

async function expectPosition(page: Page, fen: string) {
  const pieces = new Chess(fen).board().flat().filter((piece) => piece !== null);
  const squares = page.getByRole("grid").getByRole("button");
  await expect(squares.getByRole("img")).toHaveCount(pieces.length);
  const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  for (const piece of pieces) {
    await expect(page.getByRole("button", { name: piece.square, exact: true }).getByRole("img", { name: `${piece.color === "w" ? "white" : "black"} ${names[piece.type]}`, exact: true })).toBeVisible();
  }
}

test("replay waits for an opponent move, including the white opening viewed by black", async ({ page }) => {
  const fixture = await openFixture(page, [], "b");
  await expect(page.getByRole("button", { name: replayName })).toBeDisabled();
  await fixture.publish(["e4"]);
  await expect(page.getByRole("button", { name: replayName })).toBeEnabled();
  await page.getByRole("button", { name: replayName }).click();
  await expect(page.getByRole("grid")).toHaveAttribute("data-replay-phase", "before");
  await expect(page.locator('.replay-piece[data-from="e2"][data-to="e4"]')).toBeVisible();
  await page.clock.runFor(900);
  await expectPosition(page, fixture.game.fen);
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("own opening does not enable opponent replay", async ({ page }) => {
  await openFixture(page, ["e4"]);
  await expect(page.getByRole("button", { name: replayName })).toBeDisabled();
});

for (const color of ["w", "b"] as const) {
  test(`replay restores the live position after replying, ${color} orientation`, async ({ page }, testInfo) => {
    const moves = color === "w" ? ["e4", "e5", "Nf3"] : ["e4", "e5", "Nf3", "Nc6"];
    const fixture = await openFixture(page, moves, color);
    const before = structuredClone(fixture.game);
    const lastOpponent = before.moves[before.moves.length - 2];
    const replayButton = page.getByRole("button", { name: replayName });
    const board = page.getByRole("grid");
    const initialBox = await board.boundingBox();
    const buttonBox = await replayButton.boundingBox();
    const barBox = await page.locator(".clock-strip.top").boundingBox();
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(barBox!.y);
    expect(buttonBox!.height).toBeGreaterThanOrEqual(32);
    expect(Math.abs(initialBox!.width - initialBox!.height)).toBeLessThan(1);
    await page.screenshot({ path: `tmp/replay/${testInfo.project.name}-${color}-live.png` });
    await replayButton.click();
    await expect(board).toHaveAttribute("data-replay-phase", "before");
    await expect(board.getByRole("button", { name: "a1", exact: true })).toBeDisabled();
    await expect(replayButton).toBeDisabled();
    const mover = page.locator(`.replay-piece[data-from="${lastOpponent.from}"]`);
    const sourceBox = await page.getByRole("button", { name: lastOpponent.from, exact: true }).boundingBox();
    const moverBox = await mover.boundingBox();
    expect(Math.abs(moverBox!.x - sourceBox!.x)).toBeLessThan(1);
    expect(Math.abs(moverBox!.y - sourceBox!.y)).toBeLessThan(1);
    await page.clock.runFor(380);
    await expect(board).toHaveAttribute("data-replay-phase", "moving");
    await page.screenshot({ path: `tmp/replay/${testInfo.project.name}-${color}-moving.png` });
    const travelingBox = await mover.boundingBox();
    expect(Math.hypot(travelingBox!.x - moverBox!.x, travelingBox!.y - moverBox!.y)).toBeGreaterThan(1);
    await page.clock.runFor(250);
    await expect(board).toHaveAttribute("data-replay-phase", "after");
    await expectPosition(page, lastOpponent.fen);
    await page.clock.runFor(270);
    await expect(board).not.toHaveAttribute("aria-busy", "true");
    await expectPosition(page, before.fen);
    expect(await board.boundingBox()).toEqual(initialBox);
    await replayButton.focus();
    await page.keyboard.press("Enter");
    await expect(board).toHaveAttribute("aria-busy", "true");
    await page.clock.runFor(1000);
    await expectPosition(page, before.fen);
    expect(fixture.game).toEqual(before);
    expect(fixture.writes).toEqual([]);
    expect(fixture.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  });
}

const specialMoves = [
  { name: "capture", moves: ["e4", "d5", "exd5", "Qxd5"], color: "w", from: "d8", to: "d5", count: 1 },
  { name: "en passant", moves: ["e4", "a6", "e5", "d5", "exd6"], color: "b", from: "e5", to: "d6", count: 1 },
  { name: "castling", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "O-O"], color: "b", from: "e1", to: "g1", count: 2 },
  { name: "promotion", moves: ["a4", "h5", "a5", "h4", "a6", "h3", "axb7", "hxg2", "bxa8=N"], color: "b", from: "b7", to: "a8", count: 1 },
  { name: "checkmate", moves: ["f3", "e5", "g4", "Qh4#"], color: "w", from: "d8", to: "h4", count: 1 },
] as const;

for (const example of specialMoves) {
  test(`replay handles ${example.name}`, async ({ page }) => {
    const fixture = await openFixture(page, [...example.moves], example.color);
    await page.getByRole("button", { name: replayName }).click();
    await expect(page.locator(".replay-piece")).toHaveCount(example.count);
    await expect(page.locator(`.replay-piece[data-from="${example.from}"][data-to="${example.to}"]`)).toBeVisible();
    await page.clock.runFor(650);
    await expectPosition(page, fixture.game.fen);
    await page.clock.runFor(250);
    await expect(page.getByRole("button", { name: replayName })).toBeEnabled();
    await expectPosition(page, fixture.game.fen);
    expect(fixture.writes).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("new live move and game end supersede replay immediately", async ({ page }) => {
  const moves = ["e4", "e5", "Nf3"];
  const fixture = await openFixture(page, moves);
  await page.getByRole("button", { name: replayName }).click();
  await page.clock.runFor(300);
  await fixture.publish([...moves, "Nc6"]);
  await expectPosition(page, fixture.game.fen);
  await page.clock.runFor(1000);
  await expectPosition(page, fixture.game.fen);
  await page.getByRole("button", { name: replayName }).click();
  await fixture.publish([...moves, "Nc6"], "resigned");
  await expect(page.getByText("resigned", { exact: true })).toBeVisible();
  await expectPosition(page, fixture.game.fen);
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("reduced motion shows the move without piece travel and clock keeps ticking", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await openFixture(page, ["e4", "e5"]);
  await page.clock.runFor(700);
  await page.getByRole("button", { name: replayName }).click();
  await expect(page.locator(".replay-piece")).toHaveCSS("transition-duration", "0s");
  await page.clock.runFor(400);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".clock-strip.bottom time")).toHaveText("9:59");
  await page.clock.runFor(500);
  await expectPosition(page, fixture.game.fen);
  expect(fixture.writes).toEqual([]);
});
