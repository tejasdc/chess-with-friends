import { Chess } from "chess.js";
import { DurableObject } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

type PushType = "friend_request" | "challenge" | "scheduled_start";
type TimeControl = "10|0" | "5|0";
type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";
type PlayerColor = "w" | "b";

const PUSH_TYPES: PushType[] = ["friend_request", "challenge", "scheduled_start"];
const COOKIE = "cwf_session";
const APP_DO_NAME = "app";

interface Env {
  APP_NAME: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY?: string;
  ASSETS: Fetcher;
  APP_DO: DurableObjectNamespace<AppDO>;
  GAME_DO: DurableObjectNamespace<GameDO>;
}

interface CredentialRecord {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}

interface User {
  id: string;
  handle: string;
  createdAt: number;
  inviteToken: string;
  credentials: CredentialRecord[];
}

interface FriendRequest {
  id: string;
  fromId: string;
  toId: string;
  status: "pending" | "accepted" | "declined";
  createdAt: number;
}

interface Friendship {
  id: string;
  userIds: [string, string];
  createdAt: number;
}

interface Challenge {
  id: string;
  fromId: string;
  toId: string;
  timeControl: TimeControl;
  status: "pending" | "accepted" | "declined";
  gameId?: string;
  createdAt: number;
}

interface Schedule {
  id: string;
  fromId: string;
  toId: string;
  timeControl: TimeControl;
  startAt: number;
  status: "pending" | "accepted" | "fired" | "declined";
  gameId?: string;
  createdAt: number;
}

interface GameMeta {
  id: string;
  whiteId: string;
  blackId: string;
  timeControl: TimeControl;
  source: "challenge" | "schedule" | "rematch";
  status: GameStatus;
  result?: string;
  createdAt: number;
}

interface StoredSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
}

interface PendingPush {
  id: string;
  type: PushType;
  body: string;
  url: string;
  createdAt: number;
}

interface AppDb {
  users: Record<string, User>;
  handleToUserId: Record<string, string>;
  sessions: Record<string, string>;
  registrationChallenges: Record<string, { handle: string; userId: string; challenge: string; createdAt: number }>;
  authenticationChallenges: Record<string, { userId: string; challenge: string; createdAt: number }>;
  friendRequests: Record<string, FriendRequest>;
  friendships: Record<string, Friendship>;
  challenges: Record<string, Challenge>;
  schedules: Record<string, Schedule>;
  games: Record<string, GameMeta>;
  presence: Record<string, number>;
  pushSubscriptions: Record<string, StoredSubscription[]>;
  pendingPushes: Record<string, PendingPush[]>;
  pendingPushesByEndpoint: Record<string, PendingPush[]>;
  pushLog: Array<{ type: PushType; userId: string; createdAt: number; delivered: boolean; status?: number }>;
}

interface GameState {
  id: string;
  whiteId: string;
  blackId: string;
  whiteHandle: string;
  blackHandle: string;
  timeControl: TimeControl;
  fen: string;
  moves: Array<{ from: string; to: string; san: string; by: string; at: number; fen: string }>;
  whiteMs: number;
  blackMs: number;
  turn: PlayerColor;
  lastTickAt: number;
  status: GameStatus;
  result?: string;
  winnerId?: string;
  loserId?: string;
  resignedBy?: string;
  createdAt: number;
  updatedAt: number;
}

interface GameClient {
  socket: WebSocket;
  userId: string;
  handle: string;
}

function emptyDb(): AppDb {
  return {
    users: {},
    handleToUserId: {},
    sessions: {},
    registrationChallenges: {},
    authenticationChallenges: {},
    friendRequests: {},
    friendships: {},
    challenges: {},
    schedules: {},
    games: {},
    presence: {},
    pushSubscriptions: {},
    pendingPushes: {},
    pendingPushesByEndpoint: {},
    pushLog: [],
  };
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

function cleanHandle(handle: string) {
  return handle.trim().toLowerCase().replace(/^@/, "");
}

function assertHandle(handle: string) {
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
    throw new Error("Handles use 3-20 lowercase letters, numbers, or underscores.");
  }
}

function newId(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${isoBase64URL.fromBuffer(bytes)}`;
}

function getCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") || "";
  return header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function sessionCookie(token: string, url: URL) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

function clearSessionCookie(url: URL) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function rpInfo(request: Request) {
  const url = new URL(request.url);
  return {
    rpID: url.hostname,
    origin: `${url.protocol}//${url.host}`,
  };
}

function timeControlMs(control: TimeControl) {
  return control === "5|0" ? 5 * 60 * 1000 : 10 * 60 * 1000;
}

function validTimeControl(value: unknown): TimeControl {
  return value === "5|0" ? "5|0" : "10|0";
}

function friendshipId(a: string, b: string) {
  return [a, b].sort().join(":");
}

function appStub(env: Env) {
  return env.APP_DO.get(env.APP_DO.idFromName(APP_DO_NAME));
}

async function currentUser(request: Request, env: Env) {
  const response = await appStub(env).fetch(new Request(new URL("/_auth/session", request.url), {
    headers: { cookie: request.headers.get("cookie") || "" },
  }));
  if (!response.ok) return null;
  return (await response.json()) as Pick<User, "id" | "handle">;
}

async function requestForDo(request: Request, url = request.url) {
  const headers = new Headers(request.headers);
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }
  return new Request(url, init);
}

async function signVapidJwt(audience: string, subject: string, privateJwk: JsonWebKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlUtf8(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = base64UrlUtf8(JSON.stringify({ aud: audience, exp: now + 12 * 60 * 60, sub: subject }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...privateJwk, ext: false, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return `${header}.${payload}.${isoBase64URL.fromBuffer(new Uint8Array(signature))}`;
}

function base64UrlUtf8(value: string) {
  return isoBase64URL.fromBuffer(new TextEncoder().encode(value));
}

async function sendWebPush(subscription: StoredSubscription, env: Env) {
  try {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { delivered: false };
    const endpoint = new URL(subscription.endpoint);
    const jwt = await signVapidJwt(endpoint.origin, "mailto:hello@example.com", JSON.parse(env.VAPID_PRIVATE_KEY));
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        TTL: "300",
        Urgency: "normal",
        Authorization: `WebPush ${jwt}`,
        "Crypto-Key": `p256ecdsa=${env.VAPID_PUBLIC_KEY}`,
        "Content-Length": "0",
      },
    });
    return { delivered: response.ok, status: response.status };
  } catch {
    return { delivered: false };
  }
}

export class AppDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/_auth/session") return this.session(request);
      if (url.pathname === "/_internal/game-status" && request.method === "POST") return this.updateGameStatus(request);
      if (url.pathname === "/api/health") return json({ ok: true, pushTypes: PUSH_TYPES });
      if (url.pathname === "/api/push/policy") return json({ pushTypes: PUSH_TYPES });
      if (url.pathname === "/api/auth/register/options" && request.method === "POST") return this.registrationOptions(request);
      if (url.pathname === "/api/auth/register/verify" && request.method === "POST") return this.registrationVerify(request);
      if (url.pathname === "/api/auth/login/options" && request.method === "POST") return this.loginOptions(request);
      if (url.pathname === "/api/auth/login/verify" && request.method === "POST") return this.loginVerify(request);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return this.logout(request);

      const user = await this.requireUser(request);
      if (url.pathname === "/api/me" && request.method === "GET") return this.me(user);
      if (url.pathname === "/api/presence/heartbeat" && request.method === "POST") return this.heartbeat(user);
      if (url.pathname === "/api/push/subscribe" && request.method === "POST") return this.subscribe(request, user);
      if (url.pathname === "/api/push/pending" && (request.method === "GET" || request.method === "POST")) return this.pendingPush(request, user);
      if (url.pathname === "/api/friends/request" && request.method === "POST") return this.requestFriend(request, user);
      if (url.pathname === "/api/friends/invite" && request.method === "POST") return this.requestByInvite(request, user);
      if (url.pathname.match(/^\/api\/friends\/[^/]+\/accept$/) && request.method === "POST") {
        return this.acceptFriend(url.pathname.split("/")[3], user);
      }
      if (url.pathname === "/api/challenges" && request.method === "POST") return this.createChallenge(request, user);
      if (url.pathname.match(/^\/api\/challenges\/[^/]+\/accept$/) && request.method === "POST") {
        return this.acceptChallenge(url.pathname.split("/")[3], user);
      }
      if (url.pathname === "/api/schedules" && request.method === "POST") return this.createSchedule(request, user);
      if (url.pathname.match(/^\/api\/schedules\/[^/]+\/accept$/) && request.method === "POST") {
        return this.acceptSchedule(url.pathname.split("/")[3], user);
      }
      if (url.pathname === "/api/debug/push-log" && request.method === "GET") return this.debugPushLog(request);

      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Request failed" }, { status: 400 });
    }
  }

  async alarm() {
    const db = await this.db();
    const now = Date.now();
    const due = Object.values(db.schedules).filter((schedule) => schedule.status === "accepted" && schedule.startAt <= now);
    for (const schedule of due) {
      if (!schedule.gameId) {
        const game = await this.createGame(db, schedule.fromId, schedule.toId, schedule.timeControl, "schedule");
        schedule.gameId = game.id;
      }
      schedule.status = "fired";
      await this.enqueuePush(db, schedule.fromId, "scheduled_start", "Your scheduled game is starting.", `/game/${schedule.gameId}`);
      await this.enqueuePush(db, schedule.toId, "scheduled_start", "Your scheduled game is starting.", `/game/${schedule.gameId}`);
    }
    await this.save(db);
    await this.setNextScheduleAlarm(db);
  }

  private async db() {
    return ((await this.ctx.storage.get("db")) as AppDb | undefined) || emptyDb();
  }

  private save(db: AppDb) {
    return this.ctx.storage.put("db", db);
  }

  private async requireUser(request: Request) {
    const db = await this.db();
    const token = getCookie(request, COOKIE);
    const userId = token ? db.sessions[token] : undefined;
    const user = userId ? db.users[userId] : undefined;
    if (!user) throw new Error("Sign in first.");
    return user;
  }

  private async session(request: Request) {
    const db = await this.db();
    const token = getCookie(request, COOKIE);
    const userId = token ? db.sessions[token] : undefined;
    const user = userId ? db.users[userId] : undefined;
    if (!user) return json({ error: "No session" }, { status: 401 });
    return json({ id: user.id, handle: user.handle });
  }

  private async registrationOptions(request: Request) {
    const db = await this.db();
    const { handle: rawHandle } = await readJson<{ handle: string }>(request);
    const handle = cleanHandle(rawHandle || "");
    assertHandle(handle);
    if (db.handleToUserId[handle]) throw new Error("That handle is already taken.");
    const userId = newId("usr");
    const { rpID } = rpInfo(request);
    const options = await generateRegistrationOptions({
      rpName: this.env.APP_NAME || "Chess with Friends",
      rpID,
      userName: handle,
      userDisplayName: handle,
      userID: new TextEncoder().encode(userId),
      timeout: 60000,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    db.registrationChallenges[handle] = { handle, userId, challenge: options.challenge, createdAt: Date.now() };
    await this.save(db);
    return json(options);
  }

  private async registrationVerify(request: Request) {
    const db = await this.db();
    const url = new URL(request.url);
    const body = await readJson<{ handle: string; response: RegistrationResponseJSON }>(request);
    const handle = cleanHandle(body.handle || "");
    const pending = db.registrationChallenges[handle];
    if (!pending) throw new Error("Registration expired. Try again.");
    const { rpID, origin } = rpInfo(request);
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    if (!verification.verified || !verification.registrationInfo) throw new Error("Passkey registration failed.");
    const credential = verification.registrationInfo.credential;
    const user: User = {
      id: pending.userId,
      handle,
      createdAt: Date.now(),
      inviteToken: newId("inv"),
      credentials: [
        {
          id: credential.id,
          publicKey: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          transports: body.response.response.transports,
        },
      ],
    };
    db.users[user.id] = user;
    db.handleToUserId[handle] = user.id;
    delete db.registrationChallenges[handle];
    const token = newId("ses");
    db.sessions[token] = user.id;
    await this.save(db);
    return json({ user: this.publicUser(user) }, { headers: { "set-cookie": sessionCookie(token, url) } });
  }

  private async loginOptions(request: Request) {
    const db = await this.db();
    const { handle: rawHandle } = await readJson<{ handle: string }>(request);
    const handle = cleanHandle(rawHandle || "");
    const userId = db.handleToUserId[handle];
    const user = userId ? db.users[userId] : undefined;
    if (!user) throw new Error("No account with that handle.");
    const { rpID } = rpInfo(request);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: user.credentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports as never,
      })),
      userVerification: "required",
      timeout: 60000,
    });
    db.authenticationChallenges[user.id] = { userId: user.id, challenge: options.challenge, createdAt: Date.now() };
    await this.save(db);
    return json(options);
  }

  private async loginVerify(request: Request) {
    const db = await this.db();
    const url = new URL(request.url);
    const body = await readJson<{ handle: string; response: AuthenticationResponseJSON }>(request);
    const handle = cleanHandle(body.handle || "");
    const userId = db.handleToUserId[handle];
    const user = userId ? db.users[userId] : undefined;
    if (!user) throw new Error("No account with that handle.");
    const pending = db.authenticationChallenges[user.id];
    if (!pending) throw new Error("Login expired. Try again.");
    const credential = user.credentials.find((item) => item.id === body.response.id);
    if (!credential) throw new Error("Passkey not recognized.");
    const { rpID, origin } = rpInfo(request);
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports as never,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error("Passkey login failed.");
    credential.counter = verification.authenticationInfo.newCounter;
    delete db.authenticationChallenges[user.id];
    const token = newId("ses");
    db.sessions[token] = user.id;
    await this.save(db);
    return json({ user: this.publicUser(user) }, { headers: { "set-cookie": sessionCookie(token, url) } });
  }

  private async logout(request: Request) {
    const db = await this.db();
    const token = getCookie(request, COOKIE);
    if (token) delete db.sessions[token];
    await this.save(db);
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(new URL(request.url)) } });
  }

  private publicUser(user: User) {
    return { id: user.id, handle: user.handle, inviteToken: user.inviteToken };
  }

  private async me(user: User) {
    const db = await this.db();
    const now = Date.now();
    const friends = Object.values(db.friendships)
      .filter((friendship) => friendship.userIds.includes(user.id))
      .map((friendship) => {
        const friendId = friendship.userIds.find((id) => id !== user.id)!;
        const friend = db.users[friendId];
        return {
          id: friend.id,
          handle: friend.handle,
          online: now - (db.presence[friend.id] || 0) < 30000,
        };
      });
    const requests = Object.values(db.friendRequests)
      .filter((request) => request.toId === user.id && request.status === "pending")
      .map((request) => ({ ...request, fromHandle: db.users[request.fromId]?.handle }));
    const sentRequests = Object.values(db.friendRequests)
      .filter((request) => request.fromId === user.id && request.status === "pending")
      .map((request) => ({ ...request, toHandle: db.users[request.toId]?.handle }));
    const challenges = Object.values(db.challenges)
      .filter((challenge) => challenge.toId === user.id && challenge.status === "pending")
      .map((challenge) => ({ ...challenge, fromHandle: db.users[challenge.fromId]?.handle }));
    const sentChallenges = Object.values(db.challenges)
      .filter((challenge) => challenge.fromId === user.id && challenge.status === "pending")
      .map((challenge) => ({ ...challenge, toHandle: db.users[challenge.toId]?.handle }));
    const schedules = Object.values(db.schedules)
      .filter((schedule) => (schedule.toId === user.id || schedule.fromId === user.id) && schedule.status !== "declined")
      .map((schedule) => ({
        ...schedule,
        fromHandle: db.users[schedule.fromId]?.handle,
        toHandle: db.users[schedule.toId]?.handle,
      }));
    const games = Object.values(db.games).filter((game) => game.whiteId === user.id || game.blackId === user.id);
    return json({
      user: this.publicUser(user),
      inviteUrl: `/invite/${user.inviteToken}`,
      friends,
      requests,
      sentRequests,
      challenges,
      sentChallenges,
      schedules,
      games,
      pushPublicKey: this.env.VAPID_PUBLIC_KEY,
      pushTypes: PUSH_TYPES,
    });
  }

  private async heartbeat(user: User) {
    const db = await this.db();
    db.presence[user.id] = Date.now();
    await this.save(db);
    return this.me(user);
  }

  private async subscribe(request: Request, user: User) {
    const db = await this.db();
    const body = await readJson<{ subscription: StoredSubscription }>(request);
    if (!body.subscription?.endpoint) throw new Error("Missing push subscription.");
    const list = db.pushSubscriptions[user.id] || [];
    db.pushSubscriptions[user.id] = [body.subscription, ...list.filter((item) => item.endpoint !== body.subscription.endpoint)].slice(0, 5);
    await this.save(db);
    return json({ ok: true, pushTypes: PUSH_TYPES });
  }

  private async pendingPush(request: Request, user: User) {
    const db = await this.db();
    db.pendingPushesByEndpoint ||= {};
    let endpoint = "";
    if (request.method === "POST") {
      const body = await readJson<{ endpoint?: string }>(request);
      endpoint = body.endpoint || "";
    }
    const ownsEndpoint = endpoint && (db.pushSubscriptions[user.id] || []).some((subscription) => subscription.endpoint === endpoint);
    const pending = ownsEndpoint ? db.pendingPushesByEndpoint[endpoint]?.shift() || null : db.pendingPushes[user.id]?.shift() || null;
    await this.save(db);
    return json(pending);
  }

  private async requestFriend(request: Request, user: User) {
    const db = await this.db();
    const { handle: rawHandle } = await readJson<{ handle: string }>(request);
    const targetHandle = cleanHandle(rawHandle || "");
    const targetId = db.handleToUserId[targetHandle];
    const target = targetId ? db.users[targetId] : undefined;
    if (!target) throw new Error("No account with that handle.");
    return this.createFriendRequest(db, user, target);
  }

  private async requestByInvite(request: Request, user: User) {
    const db = await this.db();
    const { token } = await readJson<{ token: string }>(request);
    const target = Object.values(db.users).find((candidate) => candidate.inviteToken === token);
    if (!target) throw new Error("Invite link not found.");
    return this.createFriendRequest(db, user, target);
  }

  private async createFriendRequest(db: AppDb, user: User, target: User) {
    if (user.id === target.id) throw new Error("Use a friend's handle.");
    if (db.friendships[friendshipId(user.id, target.id)]) throw new Error("You are already friends.");
    const duplicate = Object.values(db.friendRequests).find(
      (request) =>
        request.status === "pending" &&
        ((request.fromId === user.id && request.toId === target.id) || (request.fromId === target.id && request.toId === user.id)),
    );
    if (duplicate) return json({ request: duplicate });
    const request: FriendRequest = {
      id: newId("frq"),
      fromId: user.id,
      toId: target.id,
      status: "pending",
      createdAt: Date.now(),
    };
    db.friendRequests[request.id] = request;
    await this.enqueuePush(db, target.id, "friend_request", `@${user.handle} sent you a friend request.`, "/");
    await this.save(db);
    return json({ request });
  }

  private async acceptFriend(id: string, user: User) {
    const db = await this.db();
    const request = db.friendRequests[id];
    if (!request || request.toId !== user.id || request.status !== "pending") throw new Error("Friend request not available.");
    request.status = "accepted";
    db.friendships[friendshipId(request.fromId, request.toId)] = {
      id: friendshipId(request.fromId, request.toId),
      userIds: [request.fromId, request.toId],
      createdAt: Date.now(),
    };
    await this.save(db);
    return this.me(user);
  }

  private async createChallenge(request: Request, user: User) {
    const db = await this.db();
    const body = await readJson<{ friendId: string; timeControl?: TimeControl }>(request);
    const target = db.users[body.friendId];
    this.assertFriends(db, user.id, body.friendId);
    const challenge: Challenge = {
      id: newId("chl"),
      fromId: user.id,
      toId: target.id,
      timeControl: validTimeControl(body.timeControl),
      status: "pending",
      createdAt: Date.now(),
    };
    db.challenges[challenge.id] = challenge;
    await this.enqueuePush(db, target.id, "challenge", `@${user.handle} challenged you to a game.`, "/");
    await this.save(db);
    return json({ challenge });
  }

  private async acceptChallenge(id: string, user: User) {
    const db = await this.db();
    const challenge = db.challenges[id];
    if (!challenge || challenge.toId !== user.id || challenge.status !== "pending") throw new Error("Challenge not available.");
    const game = await this.createGame(db, challenge.fromId, challenge.toId, challenge.timeControl, "challenge");
    challenge.status = "accepted";
    challenge.gameId = game.id;
    await this.save(db);
    return json({ game });
  }

  private async createSchedule(request: Request, user: User) {
    const db = await this.db();
    const body = await readJson<{ friendId: string; startAt: number; timeControl?: TimeControl }>(request);
    const target = db.users[body.friendId];
    this.assertFriends(db, user.id, body.friendId);
    const startAt = Number(body.startAt);
    if (!Number.isFinite(startAt) || startAt < Date.now() - 60000) throw new Error("Choose a future time.");
    const schedule: Schedule = {
      id: newId("sch"),
      fromId: user.id,
      toId: target.id,
      timeControl: validTimeControl(body.timeControl),
      startAt,
      status: "pending",
      createdAt: Date.now(),
    };
    db.schedules[schedule.id] = schedule;
    await this.save(db);
    return json({ schedule });
  }

  private async acceptSchedule(id: string, user: User) {
    const db = await this.db();
    const schedule = db.schedules[id];
    if (!schedule || schedule.toId !== user.id || schedule.status !== "pending") throw new Error("Schedule not available.");
    schedule.status = "accepted";
    await this.save(db);
    await this.setNextScheduleAlarm(db);
    return json({ schedule });
  }

  private async createGame(db: AppDb, whiteId: string, blackId: string, timeControl: TimeControl, source: GameMeta["source"]) {
    const white = db.users[whiteId];
    const black = db.users[blackId];
    const game: GameMeta = {
      id: newId("gam"),
      whiteId,
      blackId,
      timeControl,
      source,
      status: "active",
      createdAt: Date.now(),
    };
    db.games[game.id] = game;
    const stub = this.env.GAME_DO.get(this.env.GAME_DO.idFromName(game.id));
    await stub.fetch("https://game.local/init", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal": "app" },
      body: JSON.stringify({
        id: game.id,
        whiteId,
        blackId,
        whiteHandle: white.handle,
        blackHandle: black.handle,
        timeControl,
      }),
    });
    return game;
  }

  private assertFriends(db: AppDb, a: string, b: string) {
    if (!db.users[b]) throw new Error("Friend not found.");
    if (!db.friendships[friendshipId(a, b)]) throw new Error("You can only play friends.");
  }

  private async enqueuePush(db: AppDb, userId: string, type: PushType, body: string, url: string) {
    if (!PUSH_TYPES.includes(type)) throw new Error("Push type is not allowed.");
    const pending: PendingPush = { id: newId("psh"), type, body, url, createdAt: Date.now() };
    db.pendingPushesByEndpoint ||= {};
    const subscriptions = db.pushSubscriptions[userId] || [];
    for (const subscription of subscriptions) {
      db.pendingPushesByEndpoint[subscription.endpoint] = [...(db.pendingPushesByEndpoint[subscription.endpoint] || []), pending].slice(-20);
      const result = await sendWebPush(subscription, this.env);
      db.pushLog.push({ type, userId, createdAt: Date.now(), delivered: result.delivered, status: result.status });
    }
    if (subscriptions.length === 0) {
      db.pendingPushes[userId] = [...(db.pendingPushes[userId] || []), pending].slice(-20);
      db.pushLog.push({ type, userId, createdAt: Date.now(), delivered: false });
    }
    db.pushLog = db.pushLog.slice(-100);
  }

  private async setNextScheduleAlarm(db: AppDb) {
    const next = Object.values(db.schedules)
      .filter((schedule) => schedule.status === "accepted")
      .sort((a, b) => a.startAt - b.startAt)[0];
    if (next) await this.ctx.storage.setAlarm(next.startAt);
  }

  private async updateGameStatus(request: Request) {
    const db = await this.db();
    const body = await readJson<{ id: string; status: GameStatus; result?: string }>(request);
    if (db.games[body.id]) {
      db.games[body.id].status = body.status;
      db.games[body.id].result = body.result;
      await this.save(db);
    }
    return json({ ok: true });
  }

  private async debugPushLog(request: Request) {
    if (request.headers.get("x-debug-local") !== "true") throw new Error("Debug endpoint is local only.");
    const db = await this.db();
    return json({ pushTypes: PUSH_TYPES, pushLog: db.pushLog, pendingPushes: db.pendingPushes });
  }
}

export class GameDO extends DurableObject<Env> {
  private clients = new Map<WebSocket, GameClient>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private connectionState: Record<string, "connected" | "reconnecting" | "gone"> = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/init" && request.method === "POST") return this.init(request);
      if (url.pathname === "/socket") return this.socket(request);
      if (url.pathname === "/state") return this.stateResponse();
      if (url.pathname === "/move" && request.method === "POST") return this.move(request);
      if (url.pathname === "/resign" && request.method === "POST") return this.resign(request);
      if (url.pathname === "/debug/expire" && request.method === "POST") return this.debugExpire(request);
      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Game request failed" }, { status: 400 });
    }
  }

  async alarm() {
    const game = await this.game();
    if (!game || game.status !== "active") return;
    const changed = this.applyClock(game, Date.now());
    if (changed) {
      await this.putGame(game);
      await this.reportStatus(game);
      this.broadcast();
    } else {
      await this.setClockAlarm(game);
    }
  }

  private async init(request: Request) {
    if (request.headers.get("x-internal") !== "app") throw new Error("Internal route.");
    const existing = await this.game();
    if (existing) return json({ ok: true });
    const body = await readJson<Pick<GameState, "id" | "whiteId" | "blackId" | "whiteHandle" | "blackHandle" | "timeControl">>(request);
    const ms = timeControlMs(body.timeControl);
    const game: GameState = {
      ...body,
      fen: new Chess().fen(),
      moves: [],
      whiteMs: ms,
      blackMs: ms,
      turn: "w",
      lastTickAt: Date.now(),
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.connectionState[game.whiteId] = "gone";
    this.connectionState[game.blackId] = "gone";
    await this.putGame(game);
    await this.setClockAlarm(game);
    return json({ ok: true });
  }

  private async socket(request: Request) {
    const userId = request.headers.get("x-user-id") || "";
    const handle = request.headers.get("x-handle") || "";
    const game = await this.game();
    if (!game) throw new Error("Game not found.");
    if (![game.whiteId, game.blackId].includes(userId)) throw new Error("Only players can connect.");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.clients.set(server, { socket: server, userId, handle });
    this.connectionState[userId] = "connected";
    const timer = this.reconnectTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(userId);
    server.addEventListener("message", () => this.send(server));
    server.addEventListener("close", () => this.disconnect(server));
    server.addEventListener("error", () => this.disconnect(server));
    await this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async stateResponse() {
    return json(await this.snapshot());
  }

  private async move(request: Request) {
    const userId = request.headers.get("x-user-id") || "";
    const body = await readJson<{ from: string; to: string; promotion?: string }>(request);
    const game = await this.requirePlayer(userId);
    this.applyClock(game, Date.now());
    if (game.status !== "active") {
      await this.putGame(game);
      return json(await this.snapshotFrom(game));
    }
    const color = userId === game.whiteId ? "w" : "b";
    if (game.turn !== color) throw new Error("It is not your turn.");
    const chess = new Chess(game.fen);
    const move = chess.move({ from: body.from, to: body.to, promotion: body.promotion || "q" });
    if (!move) throw new Error("Illegal move.");
    game.fen = chess.fen();
    game.moves.push({ from: move.from, to: move.to, san: move.san, by: userId, at: Date.now(), fen: game.fen });
    game.turn = chess.turn() as PlayerColor;
    game.lastTickAt = Date.now();
    game.updatedAt = Date.now();
    if (chess.isCheckmate()) {
      game.status = "checkmate";
      game.winnerId = userId;
      game.loserId = userId === game.whiteId ? game.blackId : game.whiteId;
      game.result = color === "w" ? "1-0" : "0-1";
    } else if (chess.isDraw()) {
      game.status = "draw";
      game.result = "1/2-1/2";
    }
    await this.putGame(game);
    if (game.status === "active") await this.setClockAlarm(game);
    else await this.reportStatus(game);
    await this.broadcast();
    return json(await this.snapshotFrom(game));
  }

  private async resign(request: Request) {
    const userId = request.headers.get("x-user-id") || "";
    const game = await this.requirePlayer(userId);
    if (game.status === "active") {
      game.status = "resigned";
      game.resignedBy = userId;
      game.loserId = userId;
      game.winnerId = userId === game.whiteId ? game.blackId : game.whiteId;
      game.result = userId === game.whiteId ? "0-1" : "1-0";
      game.updatedAt = Date.now();
      await this.putGame(game);
      await this.reportStatus(game);
      await this.broadcast();
    }
    return json(await this.snapshotFrom(game));
  }

  private async debugExpire(request: Request) {
    const userId = request.headers.get("x-user-id") || "";
    const game = await this.requirePlayer(userId);
    if (game.status !== "active") return json(await this.snapshotFrom(game));
    if (game.turn === "w") game.whiteMs = 250;
    else game.blackMs = 250;
    game.lastTickAt = Date.now();
    await this.putGame(game);
    await this.setClockAlarm(game);
    await this.broadcast();
    return json(await this.snapshotFrom(game));
  }

  private disconnect(socket: WebSocket) {
    const client = this.clients.get(socket);
    if (!client) return;
    this.clients.delete(socket);
    const stillConnected = [...this.clients.values()].some((item) => item.userId === client.userId);
    if (!stillConnected) {
      this.connectionState[client.userId] = "reconnecting";
      const timer = setTimeout(() => {
        const connected = [...this.clients.values()].some((item) => item.userId === client.userId);
        if (!connected) {
          this.connectionState[client.userId] = "gone";
          void this.broadcast();
        }
      }, 3000);
      this.reconnectTimers.set(client.userId, timer);
    }
    void this.broadcast();
  }

  private async requirePlayer(userId: string) {
    const game = await this.game();
    if (!game) throw new Error("Game not found.");
    if (![game.whiteId, game.blackId].includes(userId)) throw new Error("Only players can act in this game.");
    return game;
  }

  private async snapshot() {
    const game = await this.game();
    if (!game) throw new Error("Game not found.");
    this.applyClock(game, Date.now());
    await this.putGame(game);
    if (game.status !== "active") await this.reportStatus(game);
    return this.snapshotFrom(game);
  }

  private async snapshotFrom(game: GameState) {
    return {
      ...game,
      connectionState: {
        [game.whiteId]: this.connectionState[game.whiteId] || "gone",
        [game.blackId]: this.connectionState[game.blackId] || "gone",
      },
    };
  }

  private applyClock(game: GameState, now: number) {
    if (game.status !== "active") return false;
    const elapsed = Math.max(0, now - game.lastTickAt);
    if (game.turn === "w") game.whiteMs -= elapsed;
    else game.blackMs -= elapsed;
    game.lastTickAt = now;
    if (game.whiteMs <= 0 || game.blackMs <= 0) {
      const whiteLost = game.whiteMs <= 0;
      game.whiteMs = Math.max(0, game.whiteMs);
      game.blackMs = Math.max(0, game.blackMs);
      game.status = "timeout";
      game.loserId = whiteLost ? game.whiteId : game.blackId;
      game.winnerId = whiteLost ? game.blackId : game.whiteId;
      game.result = whiteLost ? "0-1" : "1-0";
      game.updatedAt = now;
      return true;
    }
    return false;
  }

  private async game() {
    return (await this.ctx.storage.get("game")) as GameState | undefined;
  }

  private async putGame(game: GameState) {
    await this.ctx.storage.put("game", game);
  }

  private async setClockAlarm(game: GameState) {
    const remaining = game.turn === "w" ? game.whiteMs : game.blackMs;
    await this.ctx.storage.setAlarm(Date.now() + Math.max(100, remaining));
  }

  private async reportStatus(game: GameState) {
    const app = appStub(this.env);
    await app.fetch("https://app.local/_internal/game-status", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal": "game" },
      body: JSON.stringify({ id: game.id, status: game.status, result: game.result }),
    });
  }

  private async send(socket: WebSocket) {
    socket.send(JSON.stringify({ type: "state", game: await this.snapshot() }));
  }

  private async broadcast() {
    const message = JSON.stringify({ type: "state", game: await this.snapshot() });
    for (const client of this.clients.values()) {
      try {
        client.socket.send(message);
      } catch {
        this.clients.delete(client.socket);
      }
    }
  }
}

async function gameRequest(request: Request, env: Env, path: string) {
  const match = path.match(/^\/api\/games\/([^/]+)\/(.+)$/);
  if (!match) return json({ error: "Game route not found" }, { status: 404 });
  const [, gameId, action] = match;
  const isLocal = ["127.0.0.1", "localhost"].includes(new URL(request.url).hostname);
  if (action.startsWith("debug/") && !isLocal) return json({ error: "Debug endpoint is local only." }, { status: 404 });
  const user = await currentUser(request, env);
  if (!user) return json({ error: "Sign in first." }, { status: 401 });
  const target = new URL(`https://game.local/${action}`);
  const headers = new Headers(request.headers);
  headers.set("x-user-id", user.id);
  headers.set("x-handle", user.handle);
  if (action.startsWith("debug/") && isLocal) {
    headers.set("x-debug-local", "true");
  }
  const stub = env.GAME_DO.get(env.GAME_DO.idFromName(gameId));
  return stub.fetch(await requestForDo(new Request(request, { headers }), target.toString()));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/games/")) return gameRequest(request, env, url.pathname);
    if (url.pathname === "/api/debug/push-log") {
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return json({ error: "Not found" }, { status: 404 });
      const headers = new Headers(request.headers);
      headers.set("x-debug-local", "true");
      return appStub(env).fetch(await requestForDo(new Request(request, { headers })));
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_auth/")) return appStub(env).fetch(await requestForDo(request));

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    const indexUrl = new URL("/", request.url);
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
