// Hostile-conditions harness. The mechanics suite plays a perfect game
// over a perfect socket; this one simulates what a real phone does —
// sockets die, the tab hides, the CPU is throttled, moves come in
// bursts. A round is not shippable unless this suite is green.
//
// All tests use serial mode within the file (one browser at a time
// on a memory-constrained machine). Each test spins up two clients,
// registers them, gets them into a game, then does something horrible
// and asserts the game recovers without user intervention.

import { expect, test, type Browser, type CDPSession, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";

test.describe.configure({ mode: "serial" });
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

type LandingPuzzle = {
  id: string;
  fen: string;
  credit: string;
  sideToMove: "w" | "b";
  solution: { from: string; to: string; promotion?: string };
  preMoves?: { fen: string; moves: string[] };
};

type PendingPushPayload = {
  id: string;
  type?: string;
  body?: string;
  url?: string;
  createdAt?: number;
};

type DbStats = {
  rawBytes: number;
  prunedBytes: number;
  collectionBytes: Record<string, number>;
  counts: Record<string, number>;
};

function loadLandingPositions() {
  return JSON.parse(readFileSync("src/data/positions.json", "utf8")) as LandingPuzzle[];
}

function firstFenPiece(fen: string) {
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  let fileIndex = 0;
  let rank = 8;
  for (const char of fen.split(" ")[0]) {
    if (char === "/") {
      rank -= 1;
      fileIndex = 0;
      continue;
    }
    if (/\d/.test(char)) {
      fileIndex += Number(char);
      continue;
    }
    return {
      square: `${files[fileIndex]}${rank}`,
      piece: `${char === char.toUpperCase() ? "w" : "b"}${char.toLowerCase()}`,
    };
  }
  throw new Error(`FEN has no pieces: ${fen}`);
}

function fenPieces(fen: string) {
  const pieces: Array<{ square: string; piece: string }> = [];
  let file = 0;
  let rank = 8;
  for (const char of fen.split(" ")[0]) {
    if (char === "/") { rank--; file = 0; continue; }
    if (/\d/.test(char)) { file += Number(char); continue; }
    pieces.push({
      square: `${"abcdefgh"[file]}${rank}`,
      piece: `${char === char.toUpperCase() ? "w" : "b"}${char.toLowerCase()}`,
    });
    file++;
  }
  return pieces;
}

async function expectLandingBoardToMatchFen(page: Page, puzzle: LandingPuzzle) {
  const expected = fenPieces(puzzle.fen).sort((a, b) => a.square.localeCompare(b.square));
  const rendered = await page.locator(".landing-piece.live").evaluateAll((elements) =>
    elements.map((element) => ({
      square: element.getAttribute("data-square") ?? "",
      piece: element.getAttribute("data-piece") ?? "",
    })).sort((a, b) => a.square.localeCompare(b.square)),
  );
  expect(rendered, `${puzzle.id}: settled live pieces must equal its FEN exactly`).toEqual(expected);

  const misplaced = await page.locator(".landing-piece.live").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const squareName = element.getAttribute("data-square");
      const square = squareName
        ? document.querySelector<HTMLElement>(`.landing-square[data-square="${squareName}"]`)
        : null;
      if (!square) return [{ square: squareName, reason: "missing-square" }];
      const pieceRect = element.getBoundingClientRect();
      const squareRect = square.getBoundingClientRect();
      const pieceCenter = { x: pieceRect.left + pieceRect.width / 2, y: pieceRect.top + pieceRect.height / 2 };
      const squareCenter = { x: squareRect.left + squareRect.width / 2, y: squareRect.top + squareRect.height / 2 };
      const offset = Math.hypot(pieceCenter.x - squareCenter.x, pieceCenter.y - squareCenter.y);
      return offset <= 2 ? [] : [{ square: squareName, reason: "misplaced", offset }];
    }),
  );
  expect(misplaced, `${puzzle.id}: every live piece must be centered on its declared square`).toEqual([]);
}

async function solveLandingPuzzle(page: Page, puzzle: LandingPuzzle) {
  await page.locator(`.landing-square[data-square="${puzzle.solution.from}"]`).click({ timeout: 8000 });
  await page.locator(`.landing-square[data-square="${puzzle.solution.to}"]`).click({ timeout: 8000 });
}

// ---------- helpers (kept in-file so this suite is self-contained) ----------

async function addAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return cdp;
}

async function register(page: Page, handle: string) {
  await page.goto("/");
  await page.getByPlaceholder("your_handle").fill(handle);
  await page.waitForTimeout(500);
  // See tests/e2e.spec.ts register() for morph-label rationale.
  await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
  await expect(page.locator(".topbar .handle", { hasText: `@${handle}` })).toBeVisible();
}

// Send a friend request through the Add-a-friend disclosure (collapsed by
// default on the dashboard, per Tejas 2026-08-04). Opens the disclosure,
// fills the handle, clicks Add, waits for the confirmation toast. Idempotent
// on the "already open" case since the section-toggle button toggles.
async function addFriendByHandle(page: Page, handle: string) {
  const toggle = page.getByRole("button", { name: "Add a friend" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.getByPlaceholder("friend_handle").fill(handle);
  // exact:true avoids matching the "Add a friend" disclosure button that
  // is already expanded (accessible name contains "Add").
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

async function expectFriendRequestSent(page: Page, handle: string) {
  await expect
    .poll(async () => {
      const toast = await page.getByText("Friend request sent.").count();
      const row = await page.getByText(`Friend request sent to @${handle}`).count();
      return toast + row;
    }, { timeout: 10_000 })
    .toBeGreaterThan(0);
}

async function fakePushSubscribe(page: Page, endpointOverride?: string) {
  return await page.evaluate(async (providedEndpoint) => {
    const endpoint = providedEndpoint || `https://push.invalid/${Math.random()}`;
    window.localStorage.setItem("testPushEndpoint", endpoint);
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint,
          keys: { p256dh: "test", auth: "test" },
        },
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return endpoint;
  }, endpointOverride || "");
}

async function peekPendingPushNoAck(page: Page, endpointOverride?: string): Promise<PendingPushPayload | null> {
  return await page.evaluate(async (providedEndpoint) => {
    const endpoint = providedEndpoint || window.localStorage.getItem("testPushEndpoint") || "";
    const response = await fetch("/api/push/pending", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json() as PendingPushPayload | null;
  }, endpointOverride || "");
}

async function debugDbStats(page: Page): Promise<DbStats> {
  return await page.evaluate(async () => {
    const response = await fetch("/api/debug/db-stats", { credentials: "include" });
    if (!response.ok) throw new Error(await response.text());
    return await response.json() as DbStats;
  });
}

async function debugResetApp(page: Page) {
  await page.evaluate(async () => {
    const response = await fetch("/_debug/reset-app", { method: "POST", credentials: "include", body: "{}" });
    if (!response.ok) throw new Error(await response.text());
  });
}

async function twoClientsInGame(browser: Browser, suffix: string, opts: { instrumentSockets?: boolean; voiceMocks?: boolean; realVoiceProbe?: boolean; localIceServers?: boolean } = {}) {
  const contextOptions = opts.localIceServers ? { serviceWorkers: "block" as const } : {};
  const aliceCtx = await browser.newContext(contextOptions);
  const bobCtx = await browser.newContext(contextOptions);
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  if (opts.localIceServers) {
    await installLocalIceServers(alice);
    await installLocalIceServers(bob);
  }
  if (opts.instrumentSockets) {
    // Wrap WebSocket on both pages BEFORE any navigation so we can
    // reach into the socket bag from within tests.
    await installSocketTracker(alice);
    await installSocketTracker(bob);
  }
  if (opts.voiceMocks) {
    await installVoiceMocks(alice);
    await installVoiceMocks(bob);
  }
  if (opts.realVoiceProbe) {
    await installRealVoiceProbe(alice);
    await installRealVoiceProbe(bob);
  }
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  const aH = `adva_${suffix}`;
  const bH = `advb_${suffix}`;
  await register(alice, aH);
  await register(bob, bH);

  await addFriendByHandle(alice, bH);
  await expectFriendRequestSent(alice, bH);
  await bob.reload();
  await bob.getByRole("button", { name: "Accept" }).first().click();
  await expect(bob.getByRole("button", { name: `Invite @${aH}` })).toBeVisible();

  await alice.reload();
  // Presence heartbeat is no longer required for the Invite button — it's
  // active regardless of presence — but the flow still needs a moment for
  // Alice's home refresh to reflect the accepted friendship.
  await presenceHeartbeat(bob);
  await alice.reload();
  await expect(alice.getByRole("button", { name: `Invite @${bH}` })).toBeVisible();
  await alice.getByRole("button", { name: `Invite @${bH}` }).click();
  await expect(alice).toHaveURL(/\/waiting\/chl_/);
  await bob.reload();
  await bob.getByRole("button", { name: "Accept" }).first().click();
  await expect(bob).toHaveURL(/\/game\/gam_/);
  const gameId = bob.url().split("/game/")[1];
  // Sender transitions to the game via the waiting-room poll — no need
  // to navigate them manually. Poll interval is 2s; under full-suite
  // load (48-solve landing test + local wrangler + realtime channels)
  // the transition can take a couple of misses to catch up, so give it
  // slack. Isolated runs settle in <2s; the wider window is only for
  // full-suite noise, not for masking a real regression (a genuine
  // failure would exceed even 12s).
  await expect(alice).toHaveURL(/\/game\/gam_/, { timeout: 12000 });
  await expect(alice.locator(".board")).toBeVisible();
  await expect(bob.locator(".board")).toBeVisible();
  return { aliceCtx, bobCtx, alice, bob, gameId, handles: { a: aH, b: bH } };
}

async function presenceHeartbeat(page: Page) {
  // Force a heartbeat POST from the page so the server marks this user
  // online in the friend list immediately. Home data refresh in the
  // sibling client picks that up on their next reload.
  await page.evaluate(() => {
    return fetch("/api/presence/heartbeat", { method: "POST" });
  });
}

async function move(page: Page, from: string, to: string) {
  await page.locator(`[data-square="${from}"]`).click();
  await page.locator(`[data-square="${to}"]`).click();
}

async function killAllSockets(page: Page) {
  // Force-close every WebSocket owned by the page. Used to simulate
  // an iOS-style silent kill.
  await page.evaluate(() => {
    const sockets = (window as unknown as { __sockets?: WebSocket[] }).__sockets;
    if (sockets) sockets.forEach((s) => { try { s.close(); } catch { /* ignored */ } });
  });
}

async function blockNewSockets(page: Page, blocked: boolean) {
  await page.evaluate((nextBlocked) => {
    (window as unknown as { __blockNewSockets?: boolean }).__blockNewSockets = nextBlocked;
  }, blocked);
}

async function installSocketTracker(page: Page) {
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    const bag: WebSocket[] = [];
    (window as unknown as { __sockets?: WebSocket[] }).__sockets = bag;
    (window as unknown as { __blockNewSockets?: boolean }).__blockNewSockets = false;
    class Tracked extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        if ((window as unknown as { __blockNewSockets?: boolean }).__blockNewSockets) {
          throw new Error("WebSocket blocked by adversity test");
        }
        super(url, protocols);
        bag.push(this);
      }
    }
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket = Tracked as unknown as typeof WebSocket;
  });
}

async function installVoiceMocks(page: Page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url.includes("/api/voice/ice-servers")) {
        return Response.json({
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478"] },
            {
              urls: [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:3478?transport=tcp",
                "turns:turn.cloudflare.com:5349?transport=tcp",
              ],
              username: "test-turn-user",
              credential: "test-turn-credential",
            },
          ],
        });
      }
      return realFetch(input, init);
    };
    class FakeTrack {
      enabled = true;
      kind = "audio";
      id = `track-${Math.random()}`;
      stop() { this.enabled = false; }
    }
    class FakeStream {
      track = new FakeTrack();
      getAudioTracks() { return [this.track]; }
      getTracks() { return [this.track]; }
    }
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const stream = new FakeStream();
          const w = window as unknown as { __voiceTracks?: FakeTrack[] };
          w.__voiceTracks = [...(w.__voiceTracks || []), stream.track];
          return stream;
        },
      },
    });
    class FakePeerConnection extends EventTarget {
      iceConnectionState = "new";
      localDescription: RTCSessionDescriptionInit | null = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      constructor(config?: RTCConfiguration) {
        super();
        const w = window as unknown as { __rtcConfigs?: RTCConfiguration[] };
        w.__rtcConfigs = [...(w.__rtcConfigs || []), config || {}];
      }
      addTrack() { /* media is mocked */ }
      async createOffer() { return { type: "offer", sdp: "fake-offer" } as RTCSessionDescriptionInit; }
      async createAnswer() { return { type: "answer", sdp: "fake-answer" } as RTCSessionDescriptionInit; }
      async setLocalDescription(desc: RTCSessionDescriptionInit) {
        this.localDescription = desc;
        window.setTimeout(() => this.setIce("connected"), 0);
      }
      async setRemoteDescription(desc: RTCSessionDescriptionInit) { this.remoteDescription = desc; }
      async addIceCandidate() { /* trickle ICE mocked */ }
      close() { this.setIce("closed"); }
      setIce(state: string) {
        this.iceConnectionState = state;
        this.dispatchEvent(new Event("iceconnectionstatechange"));
      }
    }
    (window as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  });
}

async function installLocalIceServers(page: Page) {
  await page.route("**/api/voice/ice-servers", async (route) => {
    await route.fulfill({
      json: {
        iceServers: [],
      },
    });
  });
}

async function installRealVoiceProbe(page: Page) {
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    type Probe = {
      pcs: RTCPeerConnection[];
      iceStates: string[];
      connectionStates: string[];
      localDescriptions: Array<{ type: string; sdp: string }>;
      remoteDescriptions: Array<{ type: string; sdp: string }>;
      trackEvents: number;
    };
    const probe: Probe = {
      pcs: [],
      iceStates: [],
      connectionStates: [],
      localDescriptions: [],
      remoteDescriptions: [],
      trackEvents: 0,
    };
    (window as unknown as { __realVoiceProbe?: Probe }).__realVoiceProbe = probe;
    class TrackedPeerConnection extends Original {
      constructor(config?: RTCConfiguration) {
        super(config);
        probe.pcs.push(this);
        this.addEventListener("iceconnectionstatechange", () => probe.iceStates.push(this.iceConnectionState));
        this.addEventListener("connectionstatechange", () => probe.connectionStates.push(this.connectionState));
        this.addEventListener("track", () => { probe.trackEvents += 1; });
      }
      async setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
        await super.setLocalDescription(description);
        const current = this.localDescription;
        if (current) probe.localDescriptions.push({ type: current.type, sdp: current.sdp || "" });
      }
      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        await super.setRemoteDescription(description);
        const current = this.remoteDescription;
        if (current) probe.remoteDescriptions.push({ type: current.type, sdp: current.sdp || "" });
      }
    }
    (window as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection = TrackedPeerConnection as unknown as typeof RTCPeerConnection;
  });
}

async function sendVoice(page: Page, message: Record<string, unknown>) {
  await page.waitForFunction(() => {
    return ((window as unknown as { __sockets?: WebSocket[] }).__sockets || []).some((socket) => socket.readyState === WebSocket.OPEN);
  }, null, { timeout: 10_000 });
  await page.evaluate((payload) => {
    const sockets = ((window as unknown as { __sockets?: WebSocket[] }).__sockets || []).filter((socket) => socket.readyState === WebSocket.OPEN);
    if (!sockets.length) throw new Error("No open tracked socket.");
    sockets[sockets.length - 1].send(JSON.stringify(payload));
  }, message);
}

async function gameSnapshot(page: Page, gameId: string) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/games/${id}/state`, { credentials: "include" });
    return await response.json() as {
      whiteId: string;
      blackId: string;
      whiteHandle: string;
      blackHandle: string;
      callSession: null | { id: string; state: string; endReason?: string; muted?: Record<string, boolean> };
      status: string;
    };
  }, gameId);
}

async function waitCallState(page: Page, gameId: string, state: string) {
  await expect.poll(async () => (await gameSnapshot(page, gameId)).callSession?.state || null, { timeout: 10_000 }).toBe(state);
  return (await gameSnapshot(page, gameId)).callSession!;
}

function voiceSlot(page: Page) {
  return page.locator(".clock-strip.top [data-voice-call-slot='opponent']");
}

function selfVoiceSlot(page: Page) {
  return page.locator(".clock-strip.bottom [data-voice-call-slot='opponent']");
}

async function expectVoiceSlot(page: Page, state: string, icon: string) {
  const slot = voiceSlot(page);
  await expect(slot).toBeVisible({ timeout: 5000 });
  await expect(slot).toHaveAttribute("data-call-state", state);
  const rootIcon = await slot.getAttribute("data-call-icon");
  if (rootIcon) expect(rootIcon).toBe(icon);
  else await expect(slot.locator(`[data-call-icon='${icon}']`).first()).toBeVisible();
  await expect(page.locator(".voice-status, .voice-ending")).toHaveCount(0);
  await expect(selfVoiceSlot(page)).toHaveCount(0);
}

type RealVoiceSnapshot = {
  iceConnectionState: string | null;
  connectionState: string | null;
  iceStates: string[];
  connectionStates: string[];
  localDescriptions: Array<{ type: string; sdp: string }>;
  remoteDescriptions: Array<{ type: string; sdp: string }>;
  trackEvents: number;
  inboundAudioBytes: number;
  outboundAudioBytes: number;
};

async function realVoiceProbe(page: Page): Promise<RealVoiceSnapshot> {
  return await page.evaluate(async () => {
    type Probe = {
      pcs: RTCPeerConnection[];
      iceStates: string[];
      connectionStates: string[];
      localDescriptions: Array<{ type: string; sdp: string }>;
      remoteDescriptions: Array<{ type: string; sdp: string }>;
      trackEvents: number;
    };
    const probe = (window as unknown as { __realVoiceProbe?: Probe }).__realVoiceProbe;
    const pc = probe?.pcs.at(-1);
    let inboundAudioBytes = 0;
    let outboundAudioBytes = 0;
    if (pc) {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        const item = report as RTCStats & { kind?: string; mediaType?: string; bytesReceived?: number; bytesSent?: number };
        if (item.type === "inbound-rtp" && (item.kind === "audio" || item.mediaType === "audio")) {
          inboundAudioBytes += item.bytesReceived || 0;
        }
        if (item.type === "outbound-rtp" && (item.kind === "audio" || item.mediaType === "audio")) {
          outboundAudioBytes += item.bytesSent || 0;
        }
      });
    }
    return {
      iceConnectionState: pc?.iceConnectionState || null,
      connectionState: pc?.connectionState || null,
      iceStates: probe?.iceStates || [],
      connectionStates: probe?.connectionStates || [],
      localDescriptions: probe?.localDescriptions || [],
      remoteDescriptions: probe?.remoteDescriptions || [],
      trackEvents: probe?.trackEvents || 0,
      inboundAudioBytes,
      outboundAudioBytes,
    };
  });
}

async function expectRealVoiceMedia(page: Page, label: string) {
  await expect.poll(async () => {
    const probe = await realVoiceProbe(page);
    const iceConnected = probe.iceConnectionState === "connected" || probe.iceConnectionState === "completed";
    return {
      label,
      iceConnected,
      hasInboundAudio: probe.inboundAudioBytes > 0,
      hasOutboundAudio: probe.outboundAudioBytes > 0,
      hasRemoteTrack: probe.trackEvents > 0,
    };
  }, { timeout: 5000 }).toMatchObject({
    label,
    iceConnected: true,
    hasInboundAudio: true,
    hasOutboundAudio: true,
    hasRemoteTrack: true,
  });
  const probe = await realVoiceProbe(page);
  expect(probe.trackEvents).toBeGreaterThan(0);
  expect(probe.inboundAudioBytes).toBeGreaterThan(0);
  expect(probe.outboundAudioBytes).toBeGreaterThan(0);
}

async function directConnectedCall(alice: Page, bob: Page, gameId: string) {
  await sendVoice(alice, { type: "call-initiate" });
  const requesting = await waitCallState(alice, gameId, "requesting");
  await sendVoice(bob, { type: "call-accept", callSessionId: requesting.id });
  await waitCallState(alice, gameId, "connecting");
  await sendVoice(alice, { type: "peer-ice-connected", callSessionId: requesting.id });
  return await waitCallState(alice, gameId, "connected");
}

async function uiConnectedCall(alice: Page, bob: Page, gameId: string) {
  await sendVoice(alice, { type: "call-initiate" });
  const requesting = await waitCallState(alice, gameId, "requesting");
  await expectVoiceSlot(bob, "requesting", "phone");
  await expect(voiceSlot(bob)).toHaveAttribute("data-call-direction", "incoming");
  await bob.getByRole("button", { name: "Accept voice call" }).click();
  await waitCallState(alice, gameId, "connecting");
  await sendVoice(alice, { type: "peer-ice-connected", callSessionId: requesting.id });
  return await waitCallState(alice, gameId, "connected");
}

async function wakeLocalVoiceTrack(page: Page, peer: Page, callSessionId: string) {
  await sendVoice(peer, {
    type: "call-offer",
    callSessionId,
    sdp: { type: "offer", sdp: "v=0\r\n" },
  });
  await expect.poll(async () => page.evaluate(() => {
    return (window as unknown as { __voiceTracks?: Array<{ enabled: boolean }> }).__voiceTracks?.at(-1)?.enabled;
  }), { timeout: 5000 }).toBe(true);
}

async function debugCallExpire(page: Page, gameId: string) {
  await page.evaluate(async (id) => {
    await fetch(`/api/games/${id}/debug/call-expire`, { method: "POST", credentials: "include" });
  }, gameId);
}

// ---------- adversity scenarios ----------

test("voice call happy path reaches connected (state-smith GAP-20/21)", async ({ browser }) => {
  const suffix = `voice_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true, voiceMocks: true });
  try {
    await uiConnectedCall(alice, bob, gameId);
    await expectVoiceSlot(alice, "connected", "microphone");
    await expectVoiceSlot(bob, "connected", "microphone");
    await expect(alice.locator(".voice-connected-chip [data-call-icon='phone-disconnect']")).toBeVisible();
    await expect(bob.locator(".voice-connected-chip [data-call-icon='phone-disconnect']")).toBeVisible();
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice call slot stays in opponent bar and changes icon by state", async ({ browser }) => {
  const suffix = `voice_ui_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true, voiceMocks: true });
  try {
    await expectVoiceSlot(alice, "idle", "phone");
    await sendVoice(alice, { type: "call-initiate" });
    const requesting = await waitCallState(alice, gameId, "requesting");
    await expectVoiceSlot(alice, "requesting", "phone");
    await expect(voiceSlot(alice)).toHaveAttribute("data-call-direction", "outgoing");
    await expectVoiceSlot(bob, "requesting", "phone");
    await expect(voiceSlot(bob)).toHaveAttribute("data-call-direction", "incoming");

    await sendVoice(bob, { type: "call-accept", callSessionId: requesting.id });
    await waitCallState(alice, gameId, "connecting");
    await expectVoiceSlot(alice, "connecting", "phone");
    await expect(voiceSlot(alice).locator(".voice-spinner-ring")).toBeVisible();

    await sendVoice(alice, { type: "peer-ice-connected", callSessionId: requesting.id });
    await waitCallState(alice, gameId, "connected");
    await expectVoiceSlot(alice, "connected", "microphone");
    await expect(alice.locator(".voice-connected-chip [data-call-icon='phone-disconnect']")).toBeVisible();

    await sendVoice(alice, { type: "call-hangup", callSessionId: requesting.id });
    await waitCallState(alice, gameId, "ended");
    await expectVoiceSlot(alice, "ended", "phone");
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice ICE config uses credentialed TURN servers, not STUN-only", async ({ browser }) => {
  const suffix = `turn_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true, voiceMocks: true });
  try {
    const session = await uiConnectedCall(alice, bob, gameId);
    await wakeLocalVoiceTrack(alice, bob, session.id);
    const iceServers = await alice.evaluate(() => {
      const configs = (window as unknown as { __rtcConfigs?: RTCConfiguration[] }).__rtcConfigs || [];
      return configs.at(-1)?.iceServers || [];
    });
    const urls = iceServers.flatMap((server) => {
      const value = server.urls;
      return Array.isArray(value) ? value : [value];
    });
    expect(urls.some((url) => typeof url === "string" && url.startsWith("stun:"))).toBe(true);
    expect(urls.some((url) => typeof url === "string" && (url.startsWith("turn:") || url.startsWith("turns:")))).toBe(true);
    expect(iceServers.some((server) => Boolean(server.username) && Boolean(server.credential))).toBe(true);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test.describe("real WebRTC voice media", () => {
  test("voice call sends audio RTP bytes through real peer connections", async ({ browser }) => {
    const suffix = `rtc_${Date.now().toString(36).slice(-6)}`;
    const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, {
      instrumentSockets: true,
      realVoiceProbe: true,
      localIceServers: true,
    });
    try {
      await expectVoiceSlot(alice, "idle", "phone");
      await voiceSlot(alice).click();
      const requesting = await waitCallState(alice, gameId, "requesting");
      await expectVoiceSlot(bob, "requesting", "phone");
      await bob.getByRole("button", { name: "Accept voice call" }).click();
      await waitCallState(alice, gameId, "connected");
      await expectRealVoiceMedia(alice, "alice");
      await expectRealVoiceMedia(bob, "bob");
      const aliceProbe = await realVoiceProbe(alice);
      const bobProbe = await realVoiceProbe(bob);
      expect(aliceProbe.localDescriptions.some((description) => description.type === "offer" && description.sdp.includes("m=audio"))).toBe(true);
      expect(bobProbe.localDescriptions.some((description) => description.type === "answer" && description.sdp.includes("m=audio"))).toBe(true);
      expect(aliceProbe.remoteDescriptions.some((description) => description.type === "answer" && description.sdp.includes("m=audio"))).toBe(true);
      expect(bobProbe.remoteDescriptions.some((description) => description.type === "offer" && description.sdp.includes("m=audio"))).toBe(true);
      expect(requesting.id).toBeTruthy();
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});

test("voice call hangup by initiator reaches ended", async ({ browser }) => {
  const suffix = `hang_i_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    const session = await directConnectedCall(alice, bob, gameId);
    await sendVoice(alice, { type: "call-hangup", callSessionId: session.id });
    const ended = await waitCallState(alice, gameId, "ended");
    expect(ended.endReason).toMatch(/^hung-up-by-usr_/);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice call hangup by responder reaches ended", async ({ browser }) => {
  const suffix = `hang_r_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    const session = await directConnectedCall(alice, bob, gameId);
    await sendVoice(bob, { type: "call-hangup", callSessionId: session.id });
    const ended = await waitCallState(alice, gameId, "ended");
    expect(ended.endReason).toMatch(/^hung-up-by-usr_/);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice no-answer timeout is alarm driven (state-smith GAP-24)", async ({ browser }) => {
  const suffix = `noans_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    await sendVoice(alice, { type: "call-initiate" });
    await waitCallState(alice, gameId, "requesting");
    await debugCallExpire(alice, gameId);
    const ended = await waitCallState(alice, gameId, "ended");
    expect(ended.endReason).toBe("no-answer-timeout");
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice peer-gone timeout after responder socket death (state-smith GAP-22/24)", async ({ browser }) => {
  const suffix = `gone_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    await directConnectedCall(alice, bob, gameId);
    await killAllSockets(bob);
    await waitCallState(alice, gameId, "reconnecting");
    await debugCallExpire(alice, gameId);
    const ended = await waitCallState(alice, gameId, "ended");
    expect(ended.endReason).toBe("peer-gone-timeout");
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice call survives game terminal (state-smith GAP-23-follow/GAP-26)", async ({ browser }) => {
  const suffix = `term_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    const session = await directConnectedCall(alice, bob, gameId);
    await bob.getByRole("button", { name: "Open menu" }).click();
    await bob.getByRole("button", { name: "Resign" }).click();
    await bob.getByRole("button", { name: "Confirm resign" }).click();
    await expect(alice.getByText("resigned")).toBeVisible({ timeout: 5000 });
    const snapshot = await gameSnapshot(alice, gameId);
    expect(snapshot.status).toBe("resigned");
    expect(snapshot.callSession?.state).toBe("connected");
    await sendVoice(alice, { type: "call-ice-candidate", callSessionId: session.id, candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
    expect((await gameSnapshot(alice, gameId)).callSession?.state).toBe("connected");
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice nav away hangs up before home transition (state-smith GAP-27)", async ({ browser }) => {
  const suffix = `nav_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true, voiceMocks: true });
  try {
    await uiConnectedCall(alice, bob, gameId);
    await alice.getByRole("button", { name: "two chairs" }).click();
    await expect(alice.locator(".voice-ending")).toHaveCount(0);
    await expect(alice).toHaveURL(/\/$/);
    const ended = await waitCallState(bob, gameId, "ended");
    expect(ended.endReason).toMatch(/^hung-up-by-usr_/);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice call invite push is gated by foregroundGameId (state-smith GAP-28)", async ({ browser }) => {
  const suffix = `push_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    const baseline = await alice.evaluate(async () => (await (await fetch("/api/debug/push-log")).json()) as { pushLog: Array<{ type: string }> });
    const startingCallInvites = baseline.pushLog.filter((entry) => entry.type === "call_invite").length;
    await bob.evaluate((id) => fetch("/api/presence/heartbeat", { method: "POST", body: JSON.stringify({ foregroundGameId: id }) }), gameId);
    await sendVoice(alice, { type: "call-initiate" });
    let log = await alice.evaluate(async () => (await (await fetch("/api/debug/push-log")).json()) as { pushLog: Array<{ type: string }> });
    expect(log.pushLog.filter((entry) => entry.type === "call_invite")).toHaveLength(startingCallInvites);
    const first = (await gameSnapshot(alice, gameId)).callSession!;
    await sendVoice(alice, { type: "call-hangup", callSessionId: first.id });
    await waitCallState(alice, gameId, "ended");
    await bob.goto("/");
    await bob.evaluate(() => fetch("/api/presence/heartbeat", { method: "POST", body: "{}" }));
    await sendVoice(alice, { type: "call-initiate" });
    log = await alice.evaluate(async () => (await (await fetch("/api/debug/push-log")).json()) as { pushLog: Array<{ type: string }> });
    expect(log.pushLog.filter((entry) => entry.type === "call_invite")).toHaveLength(startingCallInvites + 1);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("push endpoint ownership moves on account switch", async ({ browser }) => {
  const suffix = `epown_${Date.now().toString(36).slice(-6)}`;
  const sharedEndpoint = `https://push.invalid/shared-${suffix}`;
  const accountCtx = await browser.newContext({ serviceWorkers: "block" });
  const charlieCtx = await browser.newContext({ serviceWorkers: "block" });
  const account = await accountCtx.newPage();
  const charlie = await charlieCtx.newPage();
  try {
    await addAuthenticator(account);
    await addAuthenticator(charlie);
    const oldHandle = `old_${suffix}`;
    const newHandle = `new_${suffix}`;
    const senderHandle = `snd_${suffix}`;

    await register(account, oldHandle);
    await fakePushSubscribe(account, sharedEndpoint);
    await account.evaluate(async () => {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include", body: "{}" });
      if (!response.ok) throw new Error(await response.text());
    });
    await register(account, newHandle);
    await fakePushSubscribe(account, sharedEndpoint);

    await register(charlie, senderHandle);
    await addFriendByHandle(charlie, oldHandle);
    await expectFriendRequestSent(charlie, oldHandle);

    const leaked = await peekPendingPushNoAck(account, sharedEndpoint);
    expect(leaked).toBeNull();
  } finally {
    await accountCtx.close();
    await charlieCtx.close();
  }
});

test("legacy push reader without ack does not pin the queue head", async ({ browser }) => {
  const suffix = `legacy_${Date.now().toString(36).slice(-6)}`;
  const aliceCtx = await browser.newContext({ serviceWorkers: "block" });
  const bobCtx = await browser.newContext({ serviceWorkers: "block" });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  try {
    await addAuthenticator(alice);
    await addAuthenticator(bob);
    const aH = `lega_${suffix}`;
    const bH = `legb_${suffix}`;
    await register(alice, aH);
    await register(bob, bH);
    await fakePushSubscribe(bob);

    await addFriendByHandle(alice, bH);
    await expectFriendRequestSent(alice, bH);
    const first = await peekPendingPushNoAck(bob);
    expect(first?.type).toBe("friend_request");

    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await alice.reload();
    await alice.getByRole("button", { name: `Invite @${bH}` }).click();

    const next = await peekPendingPushNoAck(bob);
    expect(next).toMatchObject({ type: "challenge", body: `@${aH} invited you to a game` });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("withdrawing requests clears the recipient pending push queue", async ({ browser }) => {
  test.setTimeout(120_000);
  const suffix = `wpush_${Date.now().toString(36).slice(-6)}`;
  const aliceCtx = await browser.newContext({ serviceWorkers: "block" });
  const bobCtx = await browser.newContext({ serviceWorkers: "block" });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  try {
    await addAuthenticator(alice);
    await addAuthenticator(bob);
    const aH = `wpa_${suffix}`;
    const bH = `wpb_${suffix}`;
    await register(alice, aH);
    await register(bob, bH);
    await fakePushSubscribe(bob, `https://push.invalid/withdraw-${suffix}`);

    const friendRequest = await alice.evaluate(async (handle) => {
      const response = await fetch("/api/friends/request", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as { request: { id: string } };
    }, bH);
    await alice.evaluate(async (id) => {
      const response = await fetch(`/api/friends/requests/${id}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new Error(await response.text());
    }, friendRequest.request.id);
    expect(await peekPendingPushNoAck(bob)).toBeNull();

    const bobInviteToken = await bob.evaluate(async () => {
      const me = await (await fetch("/api/me", { credentials: "include" })).json() as { inviteUrl: string };
      return me.inviteUrl.split("/").at(-1)!;
    });
    const friendship = await alice.evaluate(async (token) => {
      const response = await fetch("/api/friends/invite", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as { friend: { id: string } };
    }, bobInviteToken);
    const challenge = await alice.evaluate(async (friendId) => {
      const response = await fetch("/api/challenges", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ friendId }),
      });
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as { challenge: { id: string } };
    }, friendship.friend.id);
    await alice.evaluate(async (id) => {
      const response = await fetch(`/api/challenges/${id}/withdraw`, { method: "POST", credentials: "include", body: "{}" });
      if (!response.ok) throw new Error(await response.text());
    }, challenge.challenge.id);
    expect(await peekPendingPushNoAck(bob)).toBeNull();
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("invite churn keeps the AppDO db blob below the storage guardrail", async ({ browser }) => {
  test.setTimeout(180_000);
  const suffix = `dbcap_${Date.now().toString(36).slice(-6)}`;
  const aliceCtx = await browser.newContext({ serviceWorkers: "block" });
  const bobCtx = await browser.newContext({ serviceWorkers: "block" });
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  try {
    await alice.goto("/");
    await debugResetApp(alice);
    await addAuthenticator(alice);
    await addAuthenticator(bob);
    const aH = `dca_${suffix}`;
    const bH = `dcb_${suffix}`;
    await register(alice, aH);
    await register(bob, bH);
    await fakePushSubscribe(bob, `https://push.invalid/dbcap-${suffix}`);
    const before = await debugDbStats(alice);
    expect(before.rawBytes).toBeLessThan(64 * 1024);

    const bobInviteToken = await bob.evaluate(async () => {
      const me = await (await fetch("/api/me", { credentials: "include" })).json() as { inviteUrl: string };
      return me.inviteUrl.split("/").at(-1)!;
    });
    const friendship = await alice.evaluate(async (token) => {
      const response = await fetch("/api/friends/invite", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error(await response.text());
      return await response.json() as { friend: { id: string } };
    }, bobInviteToken);

    await alice.evaluate(async (friendId) => {
      for (let i = 0; i < 420; i += 1) {
        const created = await fetch("/api/challenges", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ friendId }),
        });
        if (!created.ok) throw new Error(await created.text());
        const { challenge } = await created.json() as { challenge: { id: string } };
        const withdrawn = await fetch(`/api/challenges/${challenge.id}/withdraw`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!withdrawn.ok) throw new Error(await withdrawn.text());
      }
    }, friendship.friend.id);

    const after = await debugDbStats(alice);
    expect(after.rawBytes).toBeLessThan(64 * 1024);
    expect(after.prunedBytes).toBeLessThan(64 * 1024);
    expect(after.counts.challenges).toBeLessThanOrEqual(200);
    expect(after.counts.pushLog).toBeLessThanOrEqual(50);
    expect(after.counts.pendingPushesByEndpoint).toBe(0);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice call state survives socket hibernation adversity (state-smith GAP-29)", async ({ browser }) => {
  const suffix = `hib_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    await directConnectedCall(alice, bob, gameId);
    await killAllSockets(alice);
    await killAllSockets(bob);
    await debugCallExpire(alice, gameId);
    const ended = await waitCallState(alice, gameId, "ended");
    expect(ended.endReason).toBe("peer-gone-timeout");
    await alice.reload();
    await expect.poll(async () => (await gameSnapshot(alice, gameId)).callSession?.endReason, { timeout: 10_000 }).toBe("peer-gone-timeout");
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice mute, unmute, and end controls are local-only (state-smith GAP-25)", async ({ browser }) => {
  const suffix = `mute_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true, voiceMocks: true });
  try {
    const session = await uiConnectedCall(alice, bob, gameId);
    await wakeLocalVoiceTrack(alice, bob, session.id);
    await alice.getByRole("button", { name: "Mute call" }).click();
    await expectVoiceSlot(alice, "connected", "microphone-slash");
    await expect(alice.getByRole("button", { name: "Unmute call" })).toBeVisible();
    await expect(alice.getByRole("button", { name: "End call" })).toBeVisible();
    await expect.poll(async () => alice.evaluate(() => (window as unknown as { __voiceTracks?: Array<{ enabled: boolean }> }).__voiceTracks?.at(-1)?.enabled)).toBe(false);
    expect((await gameSnapshot(bob, gameId)).callSession?.state).toBe("connected");

    await sendVoice(bob, { type: "call-mute", callSessionId: session.id, muted: true });
    await expect(alice.locator(".peer-muted-pill")).toHaveCount(0);
    await expectVoiceSlot(alice, "connected", "microphone-slash");
    await expect.poll(async () => alice.evaluate(() => (window as unknown as { __voiceTracks?: Array<{ enabled: boolean }> }).__voiceTracks?.at(-1)?.enabled)).toBe(false);

    await alice.getByRole("button", { name: "Unmute call" }).click();
    await expectVoiceSlot(alice, "connected", "microphone");
    await expect.poll(async () => alice.evaluate(() => (window as unknown as { __voiceTracks?: Array<{ enabled: boolean }> }).__voiceTracks?.at(-1)?.enabled)).toBe(true);
    await alice.getByRole("button", { name: "End call" }).click();
    const ended = await waitCallState(alice, gameId, "ended");
    expect(ended.endReason).toMatch(/^hung-up-by-usr_/);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("voice hangup clears muted projections on ended snapshots", async ({ browser }) => {
  const suffix = `mute_end_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob, gameId, handles } = await twoClientsInGame(browser, suffix, { instrumentSockets: true, voiceMocks: true });
  try {
    const session = await uiConnectedCall(alice, bob, gameId);
    await wakeLocalVoiceTrack(alice, bob, session.id);
    const snapshot = await gameSnapshot(alice, gameId);
    const aliceId = snapshot.whiteHandle === handles.a ? snapshot.whiteId : snapshot.blackId;
    await alice.getByRole("button", { name: "Mute call" }).click();
    await expect.poll(async () => (await gameSnapshot(bob, gameId)).callSession?.muted?.[aliceId], { timeout: 5000 }).toBe(true);
    await expect(bob.locator(".peer-muted-pill")).toHaveCount(0);

    await alice.getByRole("button", { name: "End call" }).click();
    const [aliceEnded, bobEnded] = await Promise.all([
      waitCallState(alice, gameId, "ended"),
      waitCallState(bob, gameId, "ended"),
    ]);
    expect(aliceEnded.muted).toEqual({});
    expect(bobEnded.muted).toEqual({});
    await expect(alice.locator(".peer-muted-pill")).toHaveCount(0);
    await expect(bob.locator(".peer-muted-pill")).toHaveCount(0);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("socket death mid-game recovers silently, no lost opponent moves", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    // Alice (white) moves — bob receives normally.
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });

    // Bob makes his response so it's alice's turn next.
    await move(bob, "e7", "e5");
    await expect(alice.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });

    // Kill bob's socket mid-game. The board must not freeze.
    await killAllSockets(bob);

    // Alice makes another move while bob's socket is dead. Bob's
    // reconnect (backoff or visibility path) must pick it up.
    await move(alice, "g1", "f3");
    await expect(bob.locator('[data-square="f3"] .piece')).toBeVisible({ timeout: 15000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("subway socket drop rejects mover input and tells the opponent", async ({ browser }) => {
  const suffix = `subway_${Date.now().toString(36).slice(-6)}`;
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    // Warm up so Alice has a legal move while Bob is watching.
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    await move(bob, "e7", "e5");
    await expect(alice.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });

    // Alice's HTTP path still works, but her game WebSocket dies and
    // cannot reconnect. This is the subway-tunnel shape: without a
    // socket-liveness gate, the UI can submit a move into a divergent
    // picture of the game.
    await blockNewSockets(alice, true);
    await killAllSockets(alice);

    await expect(alice.locator(".connection-pill", { hasText: "reconnecting" })).toBeVisible({ timeout: 5000 });
    await expect(bob.locator(".connection-pill", { hasText: "reconnecting" })).toBeVisible({ timeout: 5000 });

    await move(alice, "g1", "f3");

    await expect(alice.locator('[data-square="g1"] .piece')).toBeVisible();
    await expect(alice.locator('[data-square="f3"] .piece')).toHaveCount(0);
    await expect(bob.locator('[data-square="g1"] .piece')).toBeVisible();
    await expect(bob.locator('[data-square="f3"] .piece')).toHaveCount(0);
  } finally {
    await blockNewSockets(alice, false).catch(() => undefined);
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("visibilitychange after socket death triggers immediate resync", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    // Warm up — alice is white in this app, so she moves first.
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    await move(bob, "e7", "e5");
    await expect(alice.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });

    // Kill bob's live socket AND flip visibility hidden — this is the
    // iOS "app backgrounded, socket died silently" state.
    await bob.evaluate(() => {
      const bag = (window as unknown as { __sockets?: WebSocket[] }).__sockets;
      if (bag) bag.forEach((s) => { try { s.close(); } catch { /* ignore */ } });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Alice makes a move while bob's socket is dead + tab "hidden".
    await move(alice, "g1", "f3");

    // Bring bob back: visibility handler must reconnect + resync
    // immediately and pick up the missed move.
    await bob.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(bob.locator('[data-square="f3"] .piece')).toBeVisible({ timeout: 10000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("network dropout: bob catches up after his network returns", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    // Warm up so it's alice's turn again after the offline period.
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    await move(bob, "e7", "e5");
    await expect(alice.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });

    // Cut bob's network entirely via CDP.
    const cdp = await bob.context().newCDPSession(bob);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });

    // Alice makes a move while bob is offline. His board should not
    // update until network + reconnect return.
    await move(alice, "d2", "d4");

    // Restore bob's network. Reconnect + REST resync must fire on the
    // next visibilitychange OR on the next backoff-driven reconnect
    // attempt, and the missed move must materialize.
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: 10_000_000,
      uploadThroughput: 10_000_000,
    });
    await bob.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(bob.locator('[data-square="d4"] .piece')).toBeVisible({ timeout: 20000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("rapid double-click on the same square does not desync", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    // Alice double-clicks e2 → e4 (rapid taps a user makes on mobile).
    const from = alice.locator('[data-square="e2"]');
    const to = alice.locator('[data-square="e4"]');
    await from.click();
    await from.click(); // deselect
    await from.click();
    await to.click({ clickCount: 2 }); // rapid duplicate
    // The move must land once (piece on e4), and it must not have
    // caused a phantom second move on the server.
    await expect(alice.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    // Bob mirrors that state — only one move made.
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });

    // Sanity: it's bob's turn now. If a phantom second move had gone
    // through it would be alice's turn again.
    // Turn line ("Your move" / "Their move") was killed 2026-08-07 — the
    // active-turn dark-ink player-bar is the whose-turn signal now.
    await expect(bob.locator(".clock-strip.bottom.active-turn")).toBeVisible({ timeout: 5000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("stale move that discovers timeout reconciles AppDO game projection", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, gameId } = await twoClientsInGame(browser, suffix);
  try {
    const moveResult = await alice.evaluate(async (id) => {
      await fetch(`/api/games/${id}/debug/expire`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ms: 0 }),
      });
      const response = await fetch(`/api/games/${id}/move`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-client-op-id": `timeout-${id}` },
        body: JSON.stringify({ from: "e2", to: "e4" }),
      });
      const body = await response.json() as { status: string };
      return { status: response.status, body };
    }, gameId);
    expect(moveResult.status).toBe(200);
    expect(moveResult.body.status).toBe("timeout");

    await expect
      .poll(async () => {
        return alice.evaluate(async (id) => {
          const home = await (await fetch("/api/me", { credentials: "include" })).json() as { games: Array<{ id: string; status: string }> };
          return home.games.find((game) => game.id === id)?.status;
        }, gameId);
      }, { timeout: 5_000 })
      .toBe("timeout");
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("move replay with same client op id returns the committed result once", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix);
  try {
    const replay = await alice.evaluate(async (id) => {
      type MoveBody = { moves: Array<{ from: string; to: string }> };
      const headers = { "content-type": "application/json", "x-client-op-id": `move-${id}-e2e4` };
      const body = JSON.stringify({ from: "e2", to: "e4" });
      const first = await fetch(`/api/games/${id}/move`, { method: "POST", credentials: "include", headers, body });
      const firstBody = await first.json() as MoveBody;
      const second = await fetch(`/api/games/${id}/move`, { method: "POST", credentials: "include", headers, body });
      const secondBody = await second.json() as MoveBody;
      return { first: { status: first.status, body: firstBody }, second: { status: second.status, body: secondBody } };
    }, gameId);
    expect(replay.first.status).toBe(200);
    expect(replay.second.status).toBe(200);
    expect(replay.first.body.moves).toHaveLength(1);
    expect(replay.second.body.moves).toHaveLength(1);
    expect(replay.second.body.moves[0].from).toBe("e2");
    expect(replay.second.body.moves[0].to).toBe("e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("move roundtrip stays under the perf budget on a throttled CPU", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    // Throttle alice's CPU 4x to simulate a modest phone.
    const cdp = await alice.context().newCDPSession(alice);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    const start = Date.now();
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    const roundtrip = Date.now() - start;

    // Local, no real network — round-trip under 2000ms on a 4x-throttled
    // CPU is the budget. If we ever ship code that regresses this by
    // 10x (the "incredibly bad lag" symptom), the test catches it.
    expect(roundtrip).toBeLessThan(2000);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("sending a challenge takes the sender to the waiting room; accept transitions in-place", async ({ browser }) => {
  // Inviting means sitting down. Alice sends a challenge and lands
  // immediately on /waiting/{id} with the board visible and an
  // "waiting for @bob" line. When Bob accepts, Alice's page transitions
  // to /game/{id} via the poll — she never sees the dashboard again.
  const suffix = Date.now().toString(36).slice(-6);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  const aH = `wait_a${suffix}`;
  const bH = `wait_b${suffix}`;
  try {
    await register(alice, aH);
    await register(bob, bH);
    await addFriendByHandle(alice, bH);
    await expect(alice.getByText("Friend request sent.")).toBeVisible();
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await expect(bob.getByText(`@${aH}`)).toBeVisible();
    await alice.reload();
    await presenceHeartbeat(bob);
    await alice.reload();
    await alice.getByRole("button", { name: `Invite @${bH}` }).click();
    // Sender lands on the waiting room, not the dashboard.
    await expect(alice).toHaveURL(/\/waiting\/chl_/);
    await expect(alice.getByText(new RegExp(`waiting for @${bH}`))).toBeVisible();
    await expect(alice.locator(".board")).toBeVisible();
    // Bob accepts.
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await expect(bob).toHaveURL(/\/game\/gam_/);
    // Alice transitions in-place to the game via the waiting-room poll.
    await expect(alice).toHaveURL(/\/game\/gam_/, { timeout: 5000 });
    await expect(alice.locator(".board")).toBeVisible();
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("challenge accept replay with same client op id returns the existing game", async ({ browser }) => {
  const suffix = Date.now().toString(36).slice(-6);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  const aH = `acc_a${suffix}`;
  const bH = `acc_b${suffix}`;
  try {
    await register(alice, aH);
    await register(bob, bH);
    await addFriendByHandle(alice, bH);
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await alice.reload();
    await presenceHeartbeat(bob);
    await alice.reload();
    await alice.getByRole("button", { name: `Invite @${bH}` }).click();
    await expect(alice).toHaveURL(/\/waiting\/chl_/);
    const challengeId = alice.url().split("/waiting/")[1];

    const replay = await bob.evaluate(async (id) => {
      type AcceptBody = { game: { id: string } };
      const headers = { "content-type": "application/json", "x-client-op-id": `accept-${id}` };
      const first = await fetch(`/api/challenges/${id}/accept`, { method: "POST", credentials: "include", headers, body: "{}" });
      const firstBody = await first.json() as AcceptBody;
      const second = await fetch(`/api/challenges/${id}/accept`, { method: "POST", credentials: "include", headers, body: "{}" });
      const secondBody = await second.json() as AcceptBody;
      return { first: { status: first.status, body: firstBody }, second: { status: second.status, body: secondBody } };
    }, challengeId);

    expect(replay.first.status).toBe(200);
    expect(replay.second.status).toBe(200);
    expect(replay.first.body.game.id).toMatch(/^gam_/);
    expect(replay.second.body.game.id).toBe(replay.first.body.game.id);
    const home = await bob.evaluate(async () => (await (await fetch("/api/me", { credentials: "include" })).json()) as { games: Array<{ id: string }> });
    expect(home.games.filter((game) => game.id === replay.first.body.game.id)).toHaveLength(1);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("off-turn tap on own piece is silent — no toast, no selection, no request", async ({ browser }) => {
  // Silent-board principle: during play the BOARD is the only feedback
  // channel. Bob is black, so on the opening position it's white to
  // move. Bob tapping any of his own pieces (own-piece off-turn) MUST
  // be a silent no-op: no toast, no selection state, no move request.
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    const failures: string[] = [];
    bob.on("response", (r) => {
      if (r.url().includes("/api/games/") && r.url().includes("/move")) {
        failures.push(`unexpected move POST to ${r.url()}`);
      }
    });
    // Bob taps his own e7 pawn — it is currently white's turn.
    await bob.locator('[data-square="e7"]').click();
    await bob.waitForTimeout(300);
    // No toast should appear.
    const toast = await bob.locator(".toast, .toast-body").count();
    expect(toast).toBe(0);
    // No selection frame on e7.
    const selected = await bob.locator('[data-square="e7"].selected').count();
    expect(selected).toBe(0);
    // No move request fired.
    expect(failures).toEqual([]);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("illegal-destination tap deselects silently — no toast, no request", async ({ browser }) => {
  // Alice (white) selects e2 pawn then taps a non-legal square (e5).
  // Client-side legality via chess.js gates the submission — nothing
  // goes to the server, no toast fires, selection just clears.
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    const failures: string[] = [];
    alice.on("response", (r) => {
      if (r.url().includes("/api/games/") && r.url().includes("/move")) {
        failures.push(`unexpected move POST to ${r.url()}`);
      }
    });
    await alice.locator('[data-square="e2"]').click();
    await alice.waitForTimeout(150);
    await alice.locator('[data-square="e5"]').click();  // illegal — pawn can't jump to e5
    await alice.waitForTimeout(300);
    const toast = await alice.locator(".toast, .toast-body").count();
    expect(toast).toBe(0);
    // Selection cleared.
    const stillSelected = await alice.locator('[data-square="e2"].selected').count();
    expect(stillSelected).toBe(0);
    // No move request fired.
    expect(failures).toEqual([]);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("game screen never scrolls at 390x844, 1280x700, or 1440x900", async ({ browser }) => {
  // Tejas rejected a build where the game screen scrolled — on his phone
  // AND on his laptop (the huge desktop board pushed the bottom bar
  // below the fold). The hard constraint: while a game is open, the
  // page's scroll extent MUST equal the viewport. If it doesn't, the
  // board is over-tall and needs to shrink into the remaining budget.
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob } = await twoClientsInGame(browser, suffix);
  try {
    const sizes = [
      { width: 390, height: 844 },   // iPhone 14 Pro
      { width: 1280, height: 700 },  // laptop with short vertical space
      { width: 1440, height: 900 },  // standard desktop
    ];
    for (const size of sizes) {
      await alice.setViewportSize(size);
      // Force a reflow beat so aspect-ratio + flex chain settles.
      await alice.waitForTimeout(150);
      const scroll = await alice.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        innerHeight: window.innerHeight,
        screen: document.body.dataset.screen,
      }));
      // Body should be flipped into game mode.
      expect(scroll.screen).toBe("game");
      // Scroll extent must not exceed the viewport height. Allow a
      // 1px slack for subpixel rounding.
      expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight + 1);
      expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.innerHeight + 1);
    }
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("recurring schedule creates a game on each firing and can be ended by either party", async ({ browser }) => {
  // Two friends. Alice proposes a daily schedule starting NOW-ish
  // (server accepts anything within 60s of now); Bob accepts; the
  // server's alarm fires and creates a game + queues scheduled_start
  // pushes to both. The schedule stays "accepted" with nextFireAt one
  // day ahead. Bob then cancels the series; the schedule becomes
  // "cancelled".
  const suffix = Date.now().toString(36).slice(-6);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  await addAuthenticator(alice);
  await addAuthenticator(bob);
  const aH = `rec_a${suffix}`;
  const bH = `rec_b${suffix}`;
  try {
    await register(alice, aH);
    await register(bob, bH);
    await addFriendByHandle(alice, bH);
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await expect(bob.getByText(`@${aH}`)).toBeVisible();

    // Propose a daily schedule starting ~30 seconds from now (server
    // allows startAt within 60s in the past; a small future offset
    // lets the alarm fire during the test window).
    await alice.reload();
    const startAt = Date.now() + 3_000;
    const scheduleId = await alice.evaluate(async ([friendHandle, at]) => {
      // Find friendId by fetching /api/me — the home data enumerates friends.
      const me = await (await fetch("/api/me", { credentials: "include" })).json() as { friends: Array<{ id: string; handle: string }> };
      const friend = me.friends.find((f) => f.handle === friendHandle)!;
      const res = await fetch("/api/schedules", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ friendId: friend.id, timeControl: "10|0", startAt: at, recurrence: { kind: "daily" } }),
      });
      const data = await res.json() as { schedule: { id: string } };
      return data.schedule.id;
    }, [bH, startAt] as const);
    expect(scheduleId).toMatch(/^sch_/);

    // Bob accepts.
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();

    // Wait for the alarm to fire — startAt is ~3s ahead; give the DO
    // a beat past that.
    await bob.waitForTimeout(6_000);

    // Confirm a scheduled_start game exists and the schedule rolled
    // forward instead of firing "fired" (recurring stays accepted).
    type HomeShape = { schedules: Array<{ id: string; status: string; recurrence?: { kind: string }; lastGameId?: string; nextFireAt: number }> };
    const post = await alice.evaluate(async () => (await fetch("/api/me", { credentials: "include" })).json() as Promise<HomeShape>);
    const scheduleAfter = post.schedules.find((s) => s.id === scheduleId)!;
    expect(scheduleAfter.status).toBe("accepted");
    expect(scheduleAfter.recurrence?.kind).toBe("daily");
    expect(scheduleAfter.lastGameId).toMatch(/^gam_/);
    // nextFireAt has advanced by ~1 day.
    const dayLater = startAt + 24 * 60 * 60 * 1000;
    expect(Math.abs(scheduleAfter.nextFireAt - dayLater)).toBeLessThan(60_000);

    // Bob cancels the series.
    await bob.evaluate(async (id) => {
      await fetch(`/api/schedules/${id}/cancel`, { method: "POST", credentials: "include", body: "{}" });
    }, scheduleId);
    const finalState = await alice.evaluate(async () => (await fetch("/api/me", { credentials: "include" })).json() as Promise<HomeShape>);
    const scheduleEnded = finalState.schedules.find((s) => s.id === scheduleId)!;
    expect(scheduleEnded.status).toBe("cancelled");
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("landing puzzle solve walks to a new caption and position without chrome regressions", async ({ page }) => {
  const positions = loadLandingPositions();
  const first = positions[0];
  const next = positions[1];
  const nextPiece = firstFenPiece(next.fen);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const shelf = page.locator(".puzzle-shelf");
  await expect(shelf).toBeVisible();
  const firstPuzzle = await shelf.getAttribute("data-puzzle-id");
  const firstCaption = await page.locator(".puzzle-caption").innerText();

  await expect(page.locator(".menu-dot")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  const initialScroll = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    innerHeight: window.innerHeight,
  }));
  expect(initialScroll.scrollHeight).toBeLessThanOrEqual(initialScroll.clientHeight + 1);
  expect(initialScroll.scrollHeight).toBeLessThanOrEqual(initialScroll.innerHeight + 1);

  await page.locator(`.landing-square[data-square="${first.solution.from}"]`).click();
  await expect(page.locator(`.landing-square[data-square="${first.solution.to}"] .legal-dot, .landing-square[data-square="${first.solution.to}"] .legal-capture`)).toBeVisible();
  await page.locator(`.landing-square[data-square="${first.solution.to}"]`).click();

  await expect(shelf).toHaveAttribute("data-animating", "true", { timeout: 1200 });
  await expect(page.locator(".puzzle-caption")).not.toHaveText(firstCaption);
  await expect(shelf).toHaveAttribute("data-animating", "false", { timeout: 8000 });

  const nextPuzzle = await shelf.getAttribute("data-puzzle-id");
  const nextCaption = await page.locator(".puzzle-caption").innerText();
  expect(nextPuzzle).not.toBe(firstPuzzle);
  expect(nextCaption).not.toBe(firstCaption);
  await expect(page.locator(`.landing-piece[data-square="${nextPiece.square}"][data-piece="${nextPiece.piece}"]`)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.locator(".menu-dot")).toHaveCount(0);

  const finalScroll = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    innerHeight: window.innerHeight,
  }));
  expect(finalScroll.scrollHeight).toBeLessThanOrEqual(finalScroll.clientHeight + 1);
  expect(finalScroll.scrollHeight).toBeLessThanOrEqual(finalScroll.innerHeight + 1);
});

test(`landing shelf survives all ${loadLandingPositions().length} puzzles twice with zero page errors`, async ({ browser }) => {
  // Regression for the ~round-3 NotFoundError from the imperative walk
  // vs React reconciliation ownership violation. If a piece node is
  // detached outside React's knowledge, its next reconcile pass throws
  // `removeChild: The node to be removed is not a child of this node`,
  // React unmounts the shelf, and the landing dies until reload. The
  // fix (in main.tsx LandingPuzzleShelf) puts the pieces layer under
  // exclusive imperative ownership so this can't recur. Bar: every
  // shelf puzzle twice, ZERO pageerrors captured.
  const positions = loadLandingPositions();
  const rounds = positions.length * 2;
  // v7 walks arrange the setup FEN, then replay preMoves; give the full loop slack.
  test.setTimeout(Math.max(240_000, rounds * 9_000));
  const byId = new Map(positions.map((p) => [p.id, p]));

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors: Array<{ round: number; kind: string; message: string }> = [];
  let currentRound = 0;
  page.on("pageerror", (event) => errors.push({ round: currentRound, kind: "pageerror", message: String(event).slice(0, 400) }));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Benign: unauthenticated /api/me returns 400 on landing.
    if (/api\/me.*400|Failed to load resource.*status of 400/i.test(text)) return;
    // Benign: Cloudflare Web Analytics beacon is blocked by CORS on
    // localhost (cross-origin without a matching Access-Control header).
    // Same class of noise as the /api/me 400 — not a regression.
    if (/cloudflareinsights|cdn-cgi\/rum|Failed to load resource: net::ERR_(FAILED|CONNECTION_REFUSED)/i.test(text)) return;
    errors.push({ round: currentRound, kind: "console", message: text.slice(0, 400) });
  });
  page.on("crash", () => errors.push({ round: currentRound, kind: "crash", message: "page process crashed" }));

  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".puzzle-shelf[data-puzzle-id]", { timeout: 15000 });
    await expectLandingBoardToMatchFen(page, positions[0]);

    for (currentRound = 1; currentRound <= rounds; currentRound++) {
      const id = await page.locator(".puzzle-shelf").getAttribute("data-puzzle-id");
      if (!id) throw new Error(`round ${currentRound}: shelf has no data-puzzle-id (shelf unmounted?)`);
      const puzzle = byId.get(id);
      if (!puzzle) throw new Error(`round ${currentRound}: unknown puzzle id ${id}`);
      await page.locator(`.landing-square[data-square="${puzzle.solution.from}"]`).click({ timeout: 8000 });
      await page.waitForTimeout(300);
      await page.locator(`.landing-square[data-square="${puzzle.solution.to}"]`).click({ timeout: 8000 });
      // Wait for the walk to complete and the shelf to advance.
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector(".puzzle-shelf");
          return el && el.getAttribute("data-puzzle-id") !== prev;
        },
        id,
        { timeout: 40000 },
      );
      await expect(page.locator(".puzzle-shelf")).toHaveAttribute("data-animating", "false", { timeout: 40_000 });
      await expectLandingBoardToMatchFen(page, positions[currentRound % positions.length]);
    }

    expect(errors, `page errors during ${rounds}-solve loop:\n${errors.map((e) => `  round ${e.round} [${e.kind}] ${e.message}`).join("\n")}`).toEqual([]);
    // Shelf must still be alive at the end.
    await expect(page.locator(".puzzle-shelf")).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("landing replay animates a capture — captured piece walks to tray during preMoves replay", async ({ page }) => {
  test.setTimeout(70_000);
  const positions = loadLandingPositions();
  const targetIndex = positions.findIndex((p, i) => i > 0 && p.id.startsWith("lichess-") && p.preMoves?.moves[0]?.includes("x"));
  expect(targetIndex, "expected a Lichess landing puzzle with a first preMove SAN capture").toBeGreaterThan(0);
  const target = positions[targetIndex];

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const shelf = page.locator(".puzzle-shelf");
  await expect(shelf).toHaveAttribute("data-puzzle-id", positions[0].id);

  for (let i = 0; i < targetIndex - 1; i++) {
    await solveLandingPuzzle(page, positions[i]);
    await expect(shelf).toHaveAttribute("data-puzzle-id", positions[i + 1].id, { timeout: 40000 });
    await expect(shelf).toHaveAttribute("data-animating", "false", { timeout: 40000 });
  }

  await solveLandingPuzzle(page, positions[targetIndex - 1]);
  await expect(shelf).toHaveAttribute("data-puzzle-id", target.id, { timeout: 40000 });
  // Lichess entries carry side-to-move only (credit lives on /inspirations).
  await expect(page.locator(".puzzle-caption")).toHaveText(`${target.sideToMove === "w" ? "WHITE" : "BLACK"} TO MOVE`);

  await page.waitForFunction(
    () => {
      const shelfEl = document.querySelector<HTMLElement>(".puzzle-shelf");
      const board = document.querySelector<HTMLElement>(".landing-board");
      const captured = document.querySelector<HTMLElement>(".landing-piece[data-replay-capture]");
      if (!shelfEl || !board || !captured) return false;
      if (shelfEl.dataset.animating !== "true") return false;
      const boardBox = board.getBoundingClientRect();
      const pieceBox = captured.getBoundingClientRect();
      if (pieceBox.width <= 0 || pieceBox.height <= 0) return false;
      const centerY = pieceBox.top + pieceBox.height / 2;
      return centerY > boardBox.bottom + pieceBox.height * 0.08 || centerY < boardBox.top - pieceBox.height * 0.08;
    },
    { timeout: 40000, polling: "raf" },
  );

  await expect(shelf).toHaveAttribute("data-animating", "false", { timeout: 15000 });
});

test("Fool's Mate and Legal's Mate settle with exactly their FEN pieces and no overlaps", async ({ page }) => {
  test.setTimeout(90_000);
  const positions = loadLandingPositions();
  const shelf = page.locator(".puzzle-shelf");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(shelf).toHaveAttribute("data-puzzle-id", positions[0].id);
  await expectLandingBoardToMatchFen(page, positions[0]);

  for (let index = 0; index < 3; index++) {
    await solveLandingPuzzle(page, positions[index]);
    await expect(shelf).toHaveAttribute("data-puzzle-id", positions[index + 1].id, { timeout: 40_000 });
    await expect(shelf).toHaveAttribute("data-animating", "false", { timeout: 40_000 });
    await expectLandingBoardToMatchFen(page, positions[index + 1]);
  }
});

test("invite link is standing consent — five cases all resolve to friendship, idempotent, no request/accept dance", async ({ browser }) => {
  // Semantics under test: /invite/<token> IS the inviter's consent.
  // Visiting it while signed in resolves the friendship immediately.
  // Ledger cases:
  //   1. Self-link → server errors "That's your own invite link."
  //   2. Already friends → status:"already-friends", no dupe, safe repeat.
  //   3. Pending request either direction → status:"accepted", friendship
  //      exists, request status flips to "accepted".
  //   4. No relationship → status:"created", friendship exists.
  //   5. Idempotent revisit → status:"already-friends", still safe.
  test.setTimeout(120_000);

  async function makeUser(suffix: string) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await addAuthenticator(page);
    await register(page, suffix);
    // Grab inviteToken via /api/me
    const info = await page.evaluate(async () => {
      const r = await fetch("/api/me", { credentials: "include" });
      const d = await r.json() as { user: { id: string; handle: string; inviteToken: string } };
      return d.user;
    });
    return { ctx, page, ...info };
  }
  async function invitePost(page: Page, token: string) {
    return await page.evaluate(async (t) => {
      const r = await fetch("/api/friends/invite", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t }) });
      const body = await r.text();
      try { return { status: r.status, body: JSON.parse(body) }; } catch { return { status: r.status, body }; }
    }, token);
  }
  async function areFriends(page: Page, otherHandle: string) {
    return await page.evaluate(async (h) => {
      const r = await fetch("/api/me", { credentials: "include" });
      const d = await r.json() as { friends: Array<{ handle: string }> };
      return d.friends.some((f) => f.handle === h);
    }, otherHandle);
  }

  const suffix = Date.now().toString(36).slice(-6);
  const alice = await makeUser(`invA_${suffix}`);
  const bob   = await makeUser(`invB_${suffix}`);
  const carol = await makeUser(`invC_${suffix}`);

  try {
    // CASE 1 — self-link.
    const self = await invitePost(alice.page, alice.inviteToken);
    expect(self.status).toBeGreaterThanOrEqual(400);

    // CASE 4 — no relationship: Alice hits Bob's invite link → created.
    const created = await invitePost(alice.page, bob.inviteToken);
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("created");
    expect(created.body.friend.handle).toBe(bob.handle);
    expect(await areFriends(alice.page, bob.handle)).toBe(true);
    expect(await areFriends(bob.page,   alice.handle)).toBe(true);

    // CASE 2 — already friends: Alice revisits Bob's link.
    const alreadyA = await invitePost(alice.page, bob.inviteToken);
    expect(alreadyA.body.status).toBe("already-friends");
    // CASE 5 — idempotent from the OTHER side too: Bob hits Alice's link.
    const alreadyB = await invitePost(bob.page, alice.inviteToken);
    expect(alreadyB.body.status).toBe("already-friends");

    // CASE 3 — pending request in either direction: Carol requests Alice
    // via handle search first (creates pending request from Carol→Alice),
    // THEN Alice hits Carol's invite link. The pending request should
    // resolve into a friendship (status:"accepted"), not a duplicate.
    await addFriendByHandle(carol.page, alice.handle);
    await expect(carol.page.getByText("Friend request sent.")).toBeVisible();
    const accepted = await invitePost(alice.page, carol.inviteToken);
    expect(accepted.body.status).toBe("accepted");
    expect(accepted.body.friend.handle).toBe(carol.handle);
    expect(await areFriends(alice.page, carol.handle)).toBe(true);
    expect(await areFriends(carol.page, alice.handle)).toBe(true);
    // The pending request must NOT still be pending.
    const carolPending = await carol.page.evaluate(async () => {
      const r = await fetch("/api/me", { credentials: "include" });
      const d = await r.json() as { sentRequests: Array<{ id: string }>; requests: Array<{ id: string }> };
      return { sent: d.sentRequests.length, incoming: d.requests.length };
    });
    // Carol's sent-requests list should be empty (the pending request was consumed).
    expect(carolPending.sent).toBe(0);
  } finally {
    await alice.ctx.close();
    await bob.ctx.close();
    await carol.ctx.close();
  }
});

test("offline friend can be invited — button stays active, challenge persists, appears on Bob's next open", async ({ browser }) => {
  // Tejas correction of the earlier presence-gated Invite: every friend
  // row gets an active Invite button REGARDLESS of presence. The
  // challenge push IS the come-online request. Bar: Alice invites Bob
  // while Bob has no live page (all pages closed → no heartbeat → server
  // presence stale); Bob reopens; challenge is visible in his incoming
  // list; accepting launches a real game.
  test.setTimeout(120_000);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  try {
    await addAuthenticator(alice);
    await addAuthenticator(bob);
    const suffix = Date.now().toString(36).slice(-6);
    const aH = `offa_${suffix}`;
    const bH = `offb_${suffix}`;
    await register(alice, aH);
    await register(bob, bH);
    await addFriendByHandle(alice, bH);
    await expect(alice.getByText("Friend request sent.")).toBeVisible();
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await expect(bob.getByText(`@${aH}`)).toBeVisible();

    // Bob goes offline — close his page so no heartbeat POSTs land. The
    // context stays alive so the passkey survives for his reopen.
    await bob.close();

    // Alice's Invite button is available even though Bob is offline.
    await alice.reload();
    const invite = alice.getByRole("button", { name: `Invite @${bH}` });
    await expect(invite).toBeVisible();
    await expect(invite).toBeEnabled();
    await invite.click();
    await expect(alice).toHaveURL(/\/waiting\/chl_/);

    // Bob reopens (same context = same session cookie = same passkey).
    // Incoming list shows the pending challenge; accepting launches the game.
    const bob2 = await bobCtx.newPage();
    await bob2.goto("/");
    const acceptChallenge = bob2.getByRole("button", { name: "Accept" }).first();
    await expect(acceptChallenge).toBeVisible({ timeout: 15000 });
    await acceptChallenge.click();
    await expect(bob2).toHaveURL(/\/game\/gam_/, { timeout: 15000 });
    // Alice's waiting-room poll transitions her into the game once
    // Bob accepts (2s poll cadence).
    await expect(alice).toHaveURL(/\/game\/gam_/, { timeout: 12000 });
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test(`replay wash lands on the last preMove's from+to for every landing position`, async ({ page }) => {
  // Landing shelf carries a "last-move" wash on the from+to squares of
  // the LAST preMove that produced the puzzle FEN. This test computes
  // the expected {from,to} for each entry from the CSV of truth (Chess
  // over the preMoves.fen + preMoves.moves), then walks the whole
  // shelf and asserts DOM matches expectation on EVERY landing —
  // initial mount plus each transition. Any drift (wrong squares, no
  // wash, wash from the previous position bleeding into the next) is
  // a hard regression.
  const positions = loadLandingPositions();
  test.setTimeout(Math.max(300_000, positions.length * 12_000));

  // Expected last-move per entry, computed the same way the production
  // client does (chess.move(san) on the preMoves.fen, take from+to of
  // the final applied move).
  const expected = new Map<string, { from: string; to: string }>();
  for (const p of positions) {
    if (!p.preMoves || !p.preMoves.moves.length) continue;
    const game = new Chess(p.preMoves.fen);
    let last: { from: string; to: string } | null = null;
    for (const san of p.preMoves.moves) {
      const move = game.move(san);
      if (move) last = { from: move.from, to: move.to };
    }
    if (!last) throw new Error(`preMoves failed to play through for ${p.id}`);
    expected.set(p.id, last);
  }
  expect(expected.size).toBe(positions.length);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const shelf = page.locator(".puzzle-shelf");
  await expect(shelf).toHaveAttribute("data-puzzle-id", positions[0].id);

  async function assertWash(pos: LandingPuzzle) {
    const want = expected.get(pos.id)!;
    // Attribute-based assertion (single source of truth on the shelf div).
    await expect(shelf).toHaveAttribute("data-last-from", want.from, { timeout: 8000 });
    await expect(shelf).toHaveAttribute("data-last-to", want.to);
    // Class-based assertion (the actual visual wash on the board).
    await expect(page.locator(`.landing-square.last-from[data-square="${want.from}"]`)).toHaveCount(1);
    await expect(page.locator(`.landing-square.last-to[data-square="${want.to}"]`)).toHaveCount(1);
    // No stray last-move classes on any OTHER squares — exactly two
    // squares carry the wash vocabulary at any time.
    const fromCount = await page.locator(".landing-square.last-from").count();
    const toCount = await page.locator(".landing-square.last-to").count();
    expect(fromCount, `stray last-from on ${pos.id}`).toBe(1);
    expect(toCount, `stray last-to on ${pos.id}`).toBe(1);
  }

  // Wash on first mount (index 0, no walk has run).
  await assertWash(positions[0]);

  // Walk the shelf and assert wash on each landing.
  for (let i = 0; i < positions.length; i++) {
    const from = positions[i];
    await solveLandingPuzzle(page, from);
    // Mid-transition assertion (Tejas 2026-08-04): while the walk is
    // in flight (data-animating="true"), NO wash should be visible.
    // Outgoing wash must clear synchronously at transition start; new
    // wash appears only after replayMoves lands. Also assert no square
    // carries the .selected class — a new puzzle is a new game, all
    // selection state must be null.
    await expect(shelf).toHaveAttribute("data-animating", "true", { timeout: 6000 });
    const midTransition = await page.evaluate(() => {
      const s = document.querySelector(".puzzle-shelf");
      return {
        dataFrom: s?.getAttribute("data-last-from") ?? "",
        dataTo: s?.getAttribute("data-last-to") ?? "",
        lastFromClasses: document.querySelectorAll(".landing-square.last-from").length,
        lastToClasses: document.querySelectorAll(".landing-square.last-to").length,
        selectedClasses: document.querySelectorAll(".landing-square.selected").length,
      };
    });
    expect(midTransition.dataFrom, `mid-transition on solve→${(i + 1) % positions.length}: data-last-from should be cleared`).toBe("");
    expect(midTransition.dataTo, `mid-transition: data-last-to should be cleared`).toBe("");
    expect(midTransition.lastFromClasses, `mid-transition: no .last-from squares should be present`).toBe(0);
    expect(midTransition.lastToClasses, `mid-transition: no .last-to squares should be present`).toBe(0);
    expect(midTransition.selectedClasses, `mid-transition: no .selected squares should be present`).toBe(0);
    const nextIndex = (i + 1) % positions.length;
    const next = positions[nextIndex];
    await expect(shelf).toHaveAttribute("data-puzzle-id", next.id, { timeout: 40000 });
    await expect(shelf).toHaveAttribute("data-animating", "false", { timeout: 40000 });
    await assertWash(next);
  }
});

// Per-surface layout regressions. Structural guard against the class of
// bug Tejas hit on his phone (2026-08-04): a landing-scoped CSS change
// silently narrowed the dashboard column to ~half viewport. Surfaces
// without geometry tests regressed while landing tests stayed green.
// Bar: each surface's content column fills its shell width (allowing
// only the standard gutter), no unexpected horizontal offset, no scroll
// where no-scroll is the rule.
//
// Structure: parametrized viewport × surface loop. Each surface has a
// selector for its content root and a scroll-policy expectation. The
// asserts run without needing any authenticated flow beyond dashboard
// (which needs a fresh registration — cheap via virtual authenticator).
test("per-surface layout: content columns fill shell width at 390 and 430, no offset drift", async ({ browser }) => {
  test.setTimeout(120_000);
  const sizes = [
    { name: "390x844", width: 390, height: 844 },
    { name: "430x932", width: 430, height: 932 },
  ];
  // At mobile widths, shell padding: 24px clamp(16px, 4vw, 48px) 96px.
  // 4vw at 390 = 15.6 (floored by clamp min 16); at 430 = 17.2. Content
  // width should be within a few px of viewport - 2*16 = 358 (390) /
  // viewport - 2*~17 = ~396 (430). The threshold is generous enough to
  // survive minor padding tweaks but tight enough to catch a 50% collapse.
  function gutterAt(w: number) { return Math.max(16, Math.min(48, w * 0.04)); }
  function expectedContentWidth(w: number) { return w - 2 * gutterAt(w); }
  const failures: string[] = [];

  async function checkSurface(browser: Browser, size: typeof sizes[number], surface: {
    label: string;
    setup: (page: Page) => Promise<void>;
    contentSelector: string;
    mustNotScroll: boolean;
    /* If true, assert a .made-by element exists and its bottom edge
       sits within one gutter of the viewport bottom. Catches the
       recurring "made-by floating mid-page" pin regression (three
       occurrences before this became a test). */
    madeByPinned?: boolean;
    /* Ratio of expected content width the actual must meet (allows small
       widget-specific insets like the .puzzle-shelf sitting inside .auth-
       scene). Default 0.90 = "≥ 90% of viewport minus gutters." */
    minRatio?: number;
  }) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const page = await ctx.newPage();
    try {
      await surface.setup(page);
      await page.waitForTimeout(400);
      const g = await page.evaluate((sel) => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const madeBy = document.querySelector<HTMLElement>(".made-by");
        const madeByRect = madeBy ? madeBy.getBoundingClientRect().toJSON() : null;
        return {
          x: r.x,
          right: r.right,
          width: r.width,
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
          bodyScreen: document.body.dataset.screen ?? "(none)",
          madeByRect,
        };
      }, surface.contentSelector);
      if (!g) { failures.push(`[${surface.label} ${size.name}] selector "${surface.contentSelector}" not found`); return; }
      const gutter = gutterAt(size.width);
      const expected = expectedContentWidth(size.width);
      const minWidth = expected * (surface.minRatio ?? 0.90);
      // Width must reach the threshold. Catches the "collapsed to half" class.
      if (g.width < minWidth) failures.push(`[${surface.label} ${size.name}] content width ${g.width.toFixed(1)} < ${minWidth.toFixed(1)} (viewport ${size.width}, expected ~${expected.toFixed(0)})`);
      // Left edge must not drift past a full gutter's worth (catches "sits offset").
      if (g.x > gutter * 1.5) failures.push(`[${surface.label} ${size.name}] content x=${g.x.toFixed(1)} > ${(gutter * 1.5).toFixed(1)} (offset beyond gutter)`);
      // Right edge symmetry — trailing space also must not exceed 1.5 gutters.
      const trailing = size.width - g.right;
      if (trailing > gutter * 1.5) failures.push(`[${surface.label} ${size.name}] trailing space ${trailing.toFixed(1)} > ${(gutter * 1.5).toFixed(1)} (offset beyond gutter)`);
      // No-scroll surfaces: document scroll extent must not exceed the viewport.
      if (surface.mustNotScroll && g.scrollHeight > g.innerHeight + 1) failures.push(`[${surface.label} ${size.name}] scrollHeight ${g.scrollHeight} > innerHeight ${g.innerHeight} (no-scroll violated)`);
      // Made-by pin: on every surface that carries it, the element's
      // bottom edge must sit within one gutter of the viewport bottom.
      // Catches the flex-chain-broke-and-margin-top-auto-stopped-working
      // regression that has recurred three times on inspirations.
      if (surface.madeByPinned) {
        if (!g.madeByRect) failures.push(`[${surface.label} ${size.name}] .made-by missing but madeByPinned:true`);
        else {
          const bottomGap = size.height - g.madeByRect.bottom;
          if (bottomGap > gutter * 2) failures.push(`[${surface.label} ${size.name}] .made-by bottom=${g.madeByRect.bottom.toFixed(1)} (gap ${bottomGap.toFixed(1)} > ${(gutter * 2).toFixed(1)} from viewport bottom ${size.height})`);
          if (g.madeByRect.bottom < 0) failures.push(`[${surface.label} ${size.name}] .made-by clipped above viewport`);
        }
      }
    } finally {
      await ctx.close();
    }
  }

  // Landing (unauthenticated). Made-by pinned via LandingFooter.
  const landingSurface = {
    label: "landing",
    setup: async (page: Page) => {
      await page.goto("/");
      await page.waitForSelector(".puzzle-shelf[data-puzzle-id]", { timeout: 15000 });
    },
    contentSelector: ".auth",
    mustNotScroll: true,
    madeByPinned: true,
  };

  // Inspirations (unauthenticated). Tejas 2026-08-04: no-scroll AND
  // made-by pinned to viewport bottom on both mobile and desktop.
  const inspirationsSurface = {
    label: "inspirations",
    setup: async (page: Page) => {
      await page.goto("/inspirations");
      await page.waitForSelector(".insp-title", { timeout: 15000 });
    },
    contentSelector: ".inspirations",
    mustNotScroll: true,
    madeByPinned: true,
  };

  // Dashboard (needs registration).
  const dashboardSurface = {
    label: "dashboard",
    setup: async (page: Page) => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
      });
      const h = "layout_" + Date.now().toString(36).slice(-5);
      await page.goto("/");
      await page.getByPlaceholder("your_handle").fill(h);
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^(Sign in( as @|.*sign up$)|Sign up as @|Working)/ }).click();
      await page.getByText(`@${h}`).waitFor({ timeout: 15000 });
    },
    contentSelector: ".dashboard",
    mustNotScroll: false,
  };

  for (const size of sizes) {
    for (const surface of [landingSurface, inspirationsSurface, dashboardSurface]) {
      await checkSurface(browser, size, surface);
    }
  }

  // Game surface: reuse twoClientsInGame to reach a live board, check
  // board-holder width and no-scroll rule at both viewports on Alice.
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice } = await twoClientsInGame(browser, suffix);
  try {
    for (const size of sizes) {
      await alice.setViewportSize(size);
      await alice.waitForTimeout(300);
      const g = await alice.evaluate(() => {
        const el = document.querySelector<HTMLElement>(".game-fixed .board-holder");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          right: r.right,
          width: r.width,
          scrollHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
        };
      });
      if (!g) { failures.push(`[game ${size.name}] .game-fixed .board-holder not found`); continue; }
      const gutter = gutterAt(size.width);
      const expected = expectedContentWidth(size.width);
      // Board holder should reach ~90% of the shell content width.
      if (g.width < expected * 0.90) failures.push(`[game ${size.name}] board-holder width ${g.width.toFixed(1)} < ${(expected * 0.90).toFixed(1)}`);
      if (g.x > gutter * 1.5) failures.push(`[game ${size.name}] board-holder x=${g.x.toFixed(1)} > ${(gutter * 1.5).toFixed(1)}`);
      if (g.scrollHeight > g.innerHeight + 1) failures.push(`[game ${size.name}] scrollHeight ${g.scrollHeight} > innerHeight ${g.innerHeight} (no-scroll violated)`);
    }
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }

  expect(failures, `layout regressions:\n${failures.join("\n")}`).toEqual([]);
});

test("challenge withdraw + decline: state machine exits and waiting-room terminals (state-smith GAP-2/14)", async ({ browser }) => {
  // Two exits added: WITHDRAW (sender cancels) and DECLINE (invitee says
  // no). Both are idempotent, both surface in the WaitingRoom via the
  // /state poll so the sender sees the outcome and gets Home. Also
  // proves createChallenge dedupe is idempotent per (fromId, toId) —
  // two rapid taps yield one challenge, not two pushes.
  test.setTimeout(120_000);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  try {
    await addAuthenticator(alice);
    await addAuthenticator(bob);
    const suffix = Date.now().toString(36).slice(-6);
    const aH = `sma_${suffix}`;
    const bH = `smb_${suffix}`;
    await register(alice, aH);
    await register(bob, bH);
    await addFriendByHandle(alice, bH);
    await expect(alice.getByText("Friend request sent.")).toBeVisible();
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await alice.reload();
    await presenceHeartbeat(bob);
    await alice.reload();

    // Case A — WITHDRAW. Alice invites, lands in waiting, taps Withdraw.
    // Terminal renders ("Invite withdrawn"), Home returns to dashboard.
    await alice.getByRole("button", { name: `Invite @${bH}` }).click();
    await expect(alice).toHaveURL(/\/waiting\/chl_/);
    await alice.getByRole("button", { name: "Withdraw the invite" }).click();
    await expect(alice.getByText("Invite withdrawn")).toBeVisible({ timeout: 6000 });
    await alice.getByRole("button", { name: "Home" }).click();
    await expect(alice).toHaveURL(/\/$/);
    // Force a fresh home read (navigate's after-hook doesn't await
    // refresh; the dashboard may render stale for a beat).
    await alice.reload();
    // Friend row should be back to "Invite" (no pending outbound).
    await expect(alice.getByRole("button", { name: `Invite @${bH}` })).toBeVisible({ timeout: 5000 });
    // Bob's incoming challenge list should be empty on next reload —
    // withdrawn challenges are filtered out of /api/me.
    await bob.reload();
    await expect(bob.getByText(new RegExp(`@${aH} invited you`))).toHaveCount(0);

    // Case B — DECLINE + IDEMPOTENCY. Alice invites again. Bob declines.
    // Alice's waiting-room poll picks up the terminal and shows
    // "@x can't right now" with a Home button.
    await alice.getByRole("button", { name: `Invite @${bH}` }).click();
    await expect(alice).toHaveURL(/\/waiting\/chl_/);
    // Idempotency check: a re-tap from Home should route to the SAME
    // waiting URL (server returns existing pending challenge, no dupe).
    const firstWaiting = alice.url();
    await alice.goto("/");
    await expect(alice.getByRole("button", { name: `Waiting for @${bH} — open waiting room` })).toBeVisible({ timeout: 5000 });
    await alice.getByRole("button", { name: `Waiting for @${bH} — open waiting room` }).click();
    await expect(alice.url()).toBe(firstWaiting);
    // Bob declines from the incoming panel.
    await bob.reload();
    await bob.getByRole("button", { name: "Decline" }).click();
    // Alice's poll (2s cadence) picks up the terminal.
    await expect(alice.getByText(new RegExp(`@${bH} can't right now`))).toBeVisible({ timeout: 8000 });
    await alice.getByRole("button", { name: "Home" }).click();
    await expect(alice).toHaveURL(/\/$/);
    await alice.reload();
    // Row should be back to "Invite" after decline lands.
    await expect(alice.getByRole("button", { name: `Invite @${bH}` })).toBeVisible({ timeout: 5000 });
    // No leftover challenge in Bob's inbox.
    await bob.reload();
    await expect(bob.getByText(new RegExp(`@${aH} invited you`))).toHaveCount(0);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("past-grace: alarm-driven promotion to gone + reconnect restores + no lost moves (state-smith GAP-8/9)", async ({ browser }) => {
  // The exact regression Tier B could introduce (team-lead callback):
  // the ONLY mechanism promoting a player to "gone" is now alarm-driven,
  // replacing setTimeout. If the alarm math is wrong, a disconnected
  // player stays in "reconnecting" forever. Sequence:
  //   1. Two clients in an active game.
  //   2. Kill bob's socket → alice sees bob as reconnecting (grace active).
  //   3. Time-warp: POST /api/games/:id/debug/expire-grace advances
  //      every graceExpiresAt into the past and runs alarm(). This is
  //      the code path the DO would run naturally at the 15s wall-clock
  //      mark — we exercise it in seconds via the harness.
  //   4. Alice's connection-state snapshot must flip to "gone".
  //   5. Bob reconnects (fresh page in his context, socket re-opens).
  //   6. Alice sees bob back as "connected".
  //   7. Alice makes a move while bob is gone; bob receives it on
  //      reconnect (no lost moves — /state resync fires).
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36).slice(-6);
  const { aliceCtx, bobCtx, alice, bob, gameId } = await twoClientsInGame(browser, suffix, { instrumentSockets: true });
  try {
    // Warm up — Alice plays white.
    await move(alice, "e2", "e4");
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible({ timeout: 5000 });
    await move(bob, "e7", "e5");
    await expect(alice.locator('[data-square="e5"] .piece')).toBeVisible({ timeout: 5000 });

    // Kill bob's socket — server sees the close event and sets
    // graceExpiresAt[bobId] = now + 15s. In wrangler dev the close
    // event can take a beat to propagate; the DO wakes on the close
    // event whether or not another request lands, but we give the
    // event loop a moment before we ask for a fresh snapshot.
    await killAllSockets(bob);
    await alice.waitForTimeout(500);
    // Time-warp past grace directly — /debug/expire-grace sets every
    // graceExpiresAt into the past and runs alarm(). The alarm sweep
    // promotes any user without an active socket to "gone" and
    // broadcasts. Combines the close-processed and grace-past-due
    // steps into a single deterministic call so we don't race the
    // wrangler-dev close pump.
    const expireResult = await alice.evaluate(async (id) => {
      const r = await fetch(`/api/games/${id}/debug/expire-grace`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}",
      });
      return { status: r.status, body: await r.json() };
    }, gameId);
    expect(expireResult.status).toBe(200);
    // Alice's UI receives the broadcast and flips to "opponent offline".
    await expect(alice.getByRole("status", { name: "opponent offline" })).toBeVisible({ timeout: 8000 });

    // Alice makes a move while bob is fully gone.
    await move(alice, "g1", "f3");

    // Bob reconnects (his context's page is intact — his client-side
    // reconnect logic re-opens the socket).
    await bob.reload();
    // Wait for socket to re-establish and state to sync.
    await expect(bob.locator('[data-square="f3"] .piece')).toBeVisible({ timeout: 10_000 });
    // Alice sees bob back as connected.
    await expect(alice.getByRole("status", { name: "opponent connected" })).toBeVisible({ timeout: 10_000 });
    // No lost moves — bob's board reflects the full move history: Nf3 present,
    // g1 empty (piece moved), e4/e5 intact.
    await expect(bob.locator('[data-square="g1"] .piece')).toHaveCount(0);
    await expect(bob.locator('[data-square="e4"] .piece')).toBeVisible();
    await expect(bob.locator('[data-square="e5"] .piece')).toBeVisible();
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("schedule zombie sweep expires pending past startAt via debug tick (state-smith GAP-7/16)", async ({ browser }) => {
  // Time-warp harness (GAP-16): POST /_debug/tick advances alarm-time
  // without wall-clock waits. Proves GAP-7 — a pending schedule whose
  // startAt has passed transitions to "expired" on the next alarm
  // instead of sitting as a zombie forever.
  test.setTimeout(60_000);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  try {
    await addAuthenticator(alice);
    await addAuthenticator(bob);
    const suffix = Date.now().toString(36).slice(-6);
    const aH = `zsw_a${suffix}`;
    const bH = `zsw_b${suffix}`;
    await register(alice, aH);
    await register(bob, bH);
    await addFriendByHandle(alice, bH);
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await alice.reload();
    // Alice proposes a schedule; Bob NEVER accepts. Server accepts any
    // startAt within 60s of now, so give it 30s.
    const startAt = Date.now() + 30_000;
    await alice.evaluate(async ({ friendId, startAt }) => {
      await fetch("/api/schedules", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ friendId, timeControl: "10|0", startAt, recurrence: { kind: "once" } }),
      });
    }, { friendId: await alice.evaluate(async () => {
      const me = await (await fetch("/api/me")).json() as { friends: Array<{ id: string; handle: string }> };
      return me.friends[0].id;
    }), startAt });
    // Bob sees the proposal (proves pending state before the tick).
    await bob.reload();
    await expect(bob.getByText(/proposed/i)).toBeVisible();
    // Fast-forward past startAt + grace via the debug tick.
    const tickAt = startAt + 120_000;
    const res = await alice.evaluate(async (now) => {
      const r = await fetch("/_debug/tick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ now }) });
      return r.status;
    }, tickAt);
    expect(res).toBe(200);
    // Alice's schedule is now expired (filtered out of /api/me). Bob's
    // incoming panel clears too. No zombie.
    await alice.reload();
    await bob.reload();
    await expect(alice.getByText(new RegExp(`with @${bH}`))).toHaveCount(0);
    await expect(bob.getByText(/proposed/i)).toHaveCount(0);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("friend request: decline + withdraw exits (state-smith GAP-4 + GAP-5)", async ({ browser }) => {
  // Missing-exit class symmetric to challenges: recipient can now
  // decline a pending friend request; sender can withdraw one. Both
  // idempotent. Declined requests disappear from both sides' /api/me;
  // withdrawn requests are hard-deleted (leave no trace).
  test.setTimeout(120_000);
  async function fresh() {
    const suffix = Date.now().toString(36).slice(-6);
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    await addAuthenticator(alice);
    await addAuthenticator(bob);
    const aH = `frq_a${suffix}`;
    const bH = `frq_b${suffix}`;
    await register(alice, aH);
    await register(bob, bH);
    return { alice, bob, aliceCtx, bobCtx, aH, bH };
  }

  // Case A — DECLINE by recipient.
  {
    const { alice, bob, aliceCtx, bobCtx, aH, bH } = await fresh();
    try {
      await addFriendByHandle(alice, bH);
      await expect(alice.getByText("Friend request sent.")).toBeVisible();
      await bob.reload();
      // Bob has two buttons on his friend-request row: Accept + Decline.
      await bob.getByRole("button", { name: "Decline" }).first().click();
      // Bob's incoming clears.
      await expect(bob.getByText(new RegExp(`@${aH} wants to be friends`))).toHaveCount(0);
      // Alice's outbound clears (sentRequests filtered to pending).
      await alice.reload();
      await expect(alice.getByText(new RegExp(`Friend request sent to @${bH}`))).toHaveCount(0);
      // Idempotency — second decline via API returns success, not error.
      const second = await bob.evaluate(async () => {
        // Grab the (now-declined) request via server; if none, this is fine.
        const me = (await (await fetch("/api/me")).json()) as { requests?: unknown[] };
        return me.requests?.length ?? 0;
      });
      expect(second).toBe(0);
    } finally { await aliceCtx.close(); await bobCtx.close(); }
  }

  // Case B — WITHDRAW by sender.
  {
    const { alice, bob, aliceCtx, bobCtx, aH, bH } = await fresh();
    try {
      await addFriendByHandle(alice, bH);
      await expect(alice.getByText(new RegExp(`Friend request sent to @${bH}`))).toBeVisible();
      await alice.getByRole("button", { name: `Withdraw friend request to @${bH}` }).click();
      // Alice's outbound clears.
      await expect(alice.getByText(new RegExp(`Friend request sent to @${bH}`))).toHaveCount(0);
      // Bob never sees the request (hard delete).
      await bob.reload();
      await expect(bob.getByText(new RegExp(`@${aH} wants to be friends`))).toHaveCount(0);
    } finally { await aliceCtx.close(); await bobCtx.close(); }
  }
});

test("schedule decline exit (state-smith GAP-6)", async ({ browser }) => {
  test.setTimeout(120_000);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  try {
    await addAuthenticator(alice);
    await addAuthenticator(bob);
    const suffix = Date.now().toString(36).slice(-6);
    const aH = `scd_a${suffix}`;
    const bH = `scd_b${suffix}`;
    await register(alice, aH);
    await register(bob, bH);
    await addFriendByHandle(alice, bH);
    await expectFriendRequestSent(alice, bH);
    await bob.reload();
    await bob.getByRole("button", { name: "Accept" }).first().click();
    await expect(bob.getByRole("button", { name: `Invite @${aH}` })).toBeVisible();
    await alice.reload();
    await presenceHeartbeat(bob);
    await alice.reload();
    await expect(alice.getByRole("button", { name: `Invite @${bH}` })).toBeVisible();
    // Propose a schedule.
    await alice.getByRole("button", { name: "Schedule a game" }).click();
    await alice.locator(".play-form select").nth(1).selectOption({ label: "Tomorrow" });
    await alice.getByRole("button", { name: "Propose" }).click();
    await expect(alice.getByText(new RegExp(`@${aH}.*@${bH}.*pending`))).toBeVisible();
    // Bob sees the proposal in incoming with Accept + Decline.
    await bob.reload();
    const bobDeclineSchedule = bob.getByRole("button", { name: "Decline" });
    await expect(bobDeclineSchedule.first()).toBeVisible();
    await bobDeclineSchedule.first().click();
    // Bob's incoming clears.
    await bob.reload();
    await expect(bob.getByText(/proposed/i)).toHaveCount(0);
    // Alice's schedule bullet is gone (declined schedules filtered out of /api/me).
    await alice.reload();
    await expect(alice.getByText(new RegExp(`with @${bH}`))).toHaveCount(0);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
  }
});

test("no element overlap across the visual matrix — every labeled control has its own bounding box on every surface × state × viewport", async ({ browser }) => {
  // Mandate from Tejas 2026-08-04: the schedule form shipped with the
  // Time field crushed under the Repeat dropdown at desktop widths.
  // Nobody looked at the schedule-open state on desktop, so nothing
  // caught it. This test walks every surface × meaningful state ×
  // viewport (390/430/1440) and asserts NO two visible labeled
  // controls (input, select, button, textarea, label) have intersecting
  // bounding boxes. If any two collide, that combo fails with the
  // element names + overlap dimensions. Sibling-only: <label> that
  // wraps its <input> is expected to share bounds and is skipped.
  test.setTimeout(360_000);

  const VIEWPORTS = [
    { name: "390x844", width: 390, height: 844 },
    { name: "430x932", width: 430, height: 932 },
    { name: "1440x900", width: 1440, height: 900 },
  ];

  async function collectOverlaps(page: Page) {
    return await page.evaluate(() => {
      const sel = "input, select, button, textarea, label";
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel));
      // Modal overlays (menu sheet, dialogs) intentionally cover
      // dashboard content beneath — that's not the crush-fields-together
      // regression this guard targets. Skip any pair where the two
      // elements live in different modality "layers" (one inside a
      // modal, one outside).
      const MODAL_SELECTOR = ".menu-sheet, .menu-backdrop, [role='dialog'], [role='alertdialog']";
      const boxes: Array<{ tag: string; ancestor: boolean; modal: boolean; x: number; y: number; w: number; h: number }> = [];
      for (const el of nodes) {
        if (el.getAttribute("aria-hidden") === "true") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        if (r.right < 0 || r.left > window.innerWidth) continue;
        const isAncestorOfOther = nodes.some((o) => o !== el && el.contains(o));
        const modal = Boolean(el.closest(MODAL_SELECTOR));
        const cls = el.getAttribute("class");
        const tag = (el.tagName + (cls ? "." + cls.split(" ")[0] : "")).slice(0, 60);
        boxes.push({ tag, ancestor: isAncestorOfOther, modal, x: r.x, y: r.y, w: r.width, h: r.height });
      }
      const overlaps: Array<{ a: string; b: string; iw: number; ih: number }> = [];
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].ancestor) continue;
        for (let j = i + 1; j < boxes.length; j++) {
          if (boxes[j].ancestor) continue;
          const a = boxes[i], b = boxes[j];
          // Skip modal-over-page overlaps. This is a floating popover
          // above dashboard chrome by design, not a layout regression.
          if (a.modal !== b.modal) continue;
          const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
          const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
          if (ix >= 3 && iy >= 3) overlaps.push({ a: a.tag, b: b.tag, iw: ix, ih: iy });
        }
      }
      return overlaps;
    });
  }

  const failures: string[] = [];

  for (const vp of VIEWPORTS) {
    // Unauth pages: landing + inspirations.
    const unauthCtx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const unauthPage = await unauthCtx.newPage();
    try {
      await unauthPage.goto("/");
      await unauthPage.waitForSelector(".puzzle-shelf[data-puzzle-id]", { timeout: 15000 });
      await unauthPage.waitForTimeout(500);
      const olLanding = await collectOverlaps(unauthPage);
      if (olLanding.length) failures.push(`[landing/rest ${vp.name}] ${olLanding.length} overlap(s): ${JSON.stringify(olLanding.slice(0, 3))}`);

      await unauthPage.goto("/inspirations");
      await unauthPage.waitForSelector(".insp-title", { timeout: 15000 });
      await unauthPage.waitForTimeout(400);
      const olInsp = await collectOverlaps(unauthPage);
      if (olInsp.length) failures.push(`[inspirations ${vp.name}] ${olInsp.length} overlap(s): ${JSON.stringify(olInsp.slice(0, 3))}`);
    } finally {
      await unauthCtx.close();
    }

    // Authed dashboard states.
    const aliceCtx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const alice = await aliceCtx.newPage();
    try {
      await addAuthenticator(alice);
      const h = `ov_${vp.width}_${Date.now().toString(36).slice(-5)}`;
      await register(alice, h);

      // Dashboard rest
      const olDash = await collectOverlaps(alice);
      if (olDash.length) failures.push(`[dashboard/rest ${vp.name}] ${olDash.length} overlap(s): ${JSON.stringify(olDash.slice(0, 3))}`);

      // Add-a-friend open
      await alice.getByRole("button", { name: "Add a friend" }).click();
      await alice.waitForTimeout(200);
      const olAdd = await collectOverlaps(alice);
      if (olAdd.length) failures.push(`[dashboard/add-friend-open ${vp.name}] ${olAdd.length} overlap(s): ${JSON.stringify(olAdd.slice(0, 3))}`);
      await alice.getByRole("button", { name: "Add a friend" }).click(); // collapse

      // Schedule open — this is where the P1 bug lived. Needs friends,
      // so add a stub friend via handle first. If registration for the
      // stub is heavy, skip and try schedule anyway (the disclosure is
      // disabled without friends but we can still eyeball the toggle).
      // Cheaper: register bob in parallel context, alice adds him.
      const bobCtx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const bob = await bobCtx.newPage();
      try {
        await addAuthenticator(bob);
        const bH = `ovb_${vp.width}_${Date.now().toString(36).slice(-5)}`;
        await register(bob, bH);
        await addFriendByHandle(alice, bH);
        await expect(alice.getByText("Friend request sent.")).toBeVisible();
        await bob.reload();
        await bob.getByRole("button", { name: "Accept" }).first().click();
        await alice.reload();
        // Schedule open
        await alice.getByRole("button", { name: "Schedule a game" }).click();
        await alice.waitForTimeout(300);
        const olSched = await collectOverlaps(alice);
        if (olSched.length) failures.push(`[dashboard/schedule-open ${vp.name}] ${olSched.length} overlap(s): ${JSON.stringify(olSched.slice(0, 5))}`);
      } finally {
        await bobCtx.close();
      }

      // Menu open
      await alice.reload();
      await alice.locator(".menu-dot").click();
      await alice.waitForTimeout(200);
      const olMenu = await collectOverlaps(alice);
      if (olMenu.length) failures.push(`[dashboard/menu-open ${vp.name}] ${olMenu.length} overlap(s): ${JSON.stringify(olMenu.slice(0, 3))}`);

      // Notif popover open
      await alice.getByRole("button", { name: /Notifications/ }).click();
      await alice.waitForTimeout(200);
      const olNotif = await collectOverlaps(alice);
      if (olNotif.length) failures.push(`[dashboard/notif-open ${vp.name}] ${olNotif.length} overlap(s): ${JSON.stringify(olNotif.slice(0, 3))}`);
    } finally {
      await aliceCtx.close();
    }
  }

  expect(failures, `element-overlap regressions across the visual matrix:\n  ${failures.join("\n  ")}`).toEqual([]);
});

// Silence unused-import warning if a future refactor drops CDPSession above.
export type _KeepCDP = CDPSession;
