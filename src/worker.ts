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

type PushType = "friend_request" | "challenge" | "challenge_accepted" | "scheduled_start" | "call_invite";
type TimeControl = "10|0" | "5|0";
type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";
type PlayerColor = "w" | "b";
type CallSessionState = "requesting" | "connecting" | "connected" | "reconnecting" | "ended";
type CallEndReason = `hung-up-by-${string}` | "peer-gone-timeout" | "no-answer-timeout" | "failed";

// Present set of push types. This list is a descriptive snapshot of what
// the notification principle currently produces — NOT a locked cap. The
// principle (see docs/requirements.md): notifications are minimal and
// useful; one exists only when it serves the user's own intention (a
// request to them, a handshake they initiated completing, a time they
// agreed to arriving). Re-engagement categories (presence pings,
// streaks, nudges) are banned permanently. Adding to this list means
// the new push satisfies the principle — not that we're expanding a
// cap. `challenge_accepted` is here because it completes the handshake
// the inviter initiated (they invited, then went back to their life;
// this tells them the game is ready).
const PUSH_TYPES: PushType[] = ["friend_request", "challenge", "challenge_accepted", "scheduled_start", "call_invite"];
const COOKIE = "cwf_session";
const APP_DO_NAME = "app";
const PRESENCE_WINDOW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CALL_GRACE_MS = 20_000;

interface Env {
  APP_NAME: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
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
  // Terminal set per state-smith audit (docs/state-machines.md Machine 2):
  //   pending   — sender awaits recipient action
  //   accepted  — friendship created
  //   declined  — recipient dismissed (GAP-4 exit)
  // Withdraw is a hard delete of the row (GAP-5) — no "withdrawn" state
  // because the request never happened as far as the recipient is
  // concerned (mirrors the friend-request lifecycle: a request in flight
  // that the sender cancels leaves no trace).
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
  // Terminal set per state-smith audit (docs/state-machines.md Machine 3):
  //   pending    — inviter has sent, invitee has not acted
  //   accepted   — invitee accepted, gameId is set
  //   declined   — invitee said no (GAP-2 exit)
  //   withdrawn  — inviter cancelled (GAP-2 exit)
  status: "pending" | "accepted" | "declined" | "withdrawn";
  gameId?: string;
  createdAt: number;
}

// Recurrence rule on a schedule. Undefined = one-off (backcompat).
// Only two kinds in v1: weekly on a specific weekday, or daily. Anything
// else (monthly, N-times-per-week, exceptions) is deliberately out.
type Recurrence =
  | { kind: "once" }
  | { kind: "weekly"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "daily" };

interface Schedule {
  id: string;
  fromId: string;
  toId: string;
  timeControl: TimeControl;
  startAt: number;
  // nextFireAt is the SCHEDULING cursor — set to startAt on create, advanced
  // by the recurrence interval on each firing. For one-off schedules this
  // equals startAt until the schedule fires (status → "fired").
  nextFireAt: number;
  // Recurrence is optional for backwards-compatibility with stored records
  // written before this field existed; treat missing as {kind:"once"}.
  recurrence?: Recurrence;
  // "cancelled" is the series-level end (either party can trigger it).
  // "fired" only applies to one-off schedules that have already run;
  // recurring schedules stay "accepted" until cancelled.
  // Terminal set per state-smith audit (docs/state-machines.md Machine 4):
  //   pending   — proposer awaits recipient
  //   accepted  — one-off pre-fire OR recurring steady state
  //   fired     — one-off has run (gameId set); recurring never enters this
  //   declined  — recipient dismissed (GAP-6 exit)
  //   cancelled — either party ended the series
  //   expired   — pending schedule whose startAt passed with grace (GAP-7 sweep)
  status: "pending" | "accepted" | "fired" | "declined" | "cancelled" | "expired";
  gameId?: string;           // legacy one-off field — kept for old data
  lastGameId?: string;       // most-recent fired game for recurring series
  cancelledBy?: string;      // userId who ended the series
  createdAt: number;
}

function recurrenceOf(s: Schedule): Recurrence {
  return s.recurrence || { kind: "once" };
}

// Advance a fire time by ONE interval per recurrence kind. Callers loop
// until the returned time is strictly in the future — that's how a
// missed catch-up firing skips forward without piling up games.
function advanceFireTime(current: number, r: Recurrence): number {
  const DAY = 24 * 60 * 60 * 1000;
  switch (r.kind) {
    case "weekly": return current + 7 * DAY;
    case "daily":  return current + DAY;
    case "once":   return current; // unreached — one-offs don't advance
  }
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

interface PresenceRecord {
  lastSeenAt: number;
  foregroundGameId?: string;
}

interface CallSession {
  id: string;
  initiatorId: string;
  state: CallSessionState;
  startedAt: number;
  acceptedAt?: number;
  graceExpiresAt?: number;
  endedAt?: number;
  endReason?: CallEndReason;
  muted: Record<string, boolean>;
}

interface StoredOpResult {
  userId: string;
  opId: string;
  createdAt: number;
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface ClientErrorRecord {
  id: string;
  createdAt: number;
  url: string;
  message: string;
  stack?: string;
  userAgent: string;
  userId?: string;
}

interface PushDeliveryIntent {
  userId: string;
  pushId: string;
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
  presence: Record<string, number | PresenceRecord>;
  pushSubscriptions: Record<string, StoredSubscription[]>;
  pendingPushes: Record<string, PendingPush[]>;
  pendingPushesByEndpoint: Record<string, PendingPush[]>;
  pushLog: Array<{ type: PushType; userId: string; createdAt: number; delivered: boolean; status?: number }>;
  opResults: Record<string, StoredOpResult>;
  rateLimits: Record<string, RateLimitBucket>;
  clientErrors: ClientErrorRecord[];
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
    opResults: {},
    rateLimits: {},
    clientErrors: [],
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

// State-smith GAP-13: cap the lifetime of ephemeral WebAuthn challenge
// records. Both maps accumulate one entry per (handle | userId) probe;
// old entries are unusable once a fresh /options overwrites them, but
// probes for handles that never verify would sit forever otherwise.
// 10-minute lifetime is generously past the WebAuthn dialog's own 60s
// timeout and covers slow user-verification steps on some devices.
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_AUTH_CHALLENGES = 200;
const OP_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OP_RESULTS = 1_000;
const RATE_LIMIT_MAX_BUCKETS = 1_000;
const CLIENT_ERROR_LIMIT = 500;

function sweepExpiredChallenges(db: AppDb) {
  const cutoff = Date.now() - CHALLENGE_TTL_MS;
  for (const [handle, record] of Object.entries(db.registrationChallenges)) {
    if (record.createdAt < cutoff) delete db.registrationChallenges[handle];
  }
  for (const [userId, record] of Object.entries(db.authenticationChallenges)) {
    if (record.createdAt < cutoff) delete db.authenticationChallenges[userId];
  }
  pruneRecordMap(db.registrationChallenges, MAX_AUTH_CHALLENGES);
  pruneRecordMap(db.authenticationChallenges, MAX_AUTH_CHALLENGES);
}

function pruneRecordMap<T extends { createdAt: number }>(record: Record<string, T>, max: number) {
  const entries = Object.entries(record);
  if (entries.length <= max) return;
  entries
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, entries.length - max)
    .forEach(([key]) => delete record[key]);
}

function normalizeDb(db: AppDb): AppDb {
  db.pendingPushesByEndpoint ||= {};
  db.opResults ||= {};
  db.rateLimits ||= {};
  db.clientErrors ||= [];
  return db;
}

function presenceSeenAt(record: number | PresenceRecord | undefined): number {
  return typeof record === "number" ? record : record?.lastSeenAt || 0;
}

function presenceForegroundGameId(record: number | PresenceRecord | undefined): string | undefined {
  return typeof record === "number" ? undefined : record?.foregroundGameId;
}

function cloudflareStunOnly(): RTCIceServer[] {
  return [{ urls: ["stun:stun.cloudflare.com:3478"] }];
}

function clientOpId(request: Request) {
  const value = request.headers.get("x-client-op-id") || request.headers.get("x-op-id") || "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "";
}

function opKey(userId: string, opId: string) {
  return `${userId}:${opId}`;
}

function responseFromStoredOp(stored: StoredOpResult) {
  return new Response(stored.body, { status: stored.status, headers: stored.headers });
}

async function storeResponseForOp(response: Response, userId: string, opId: string): Promise<{ stored: StoredOpResult; response: Response }> {
  const body = await response.clone().text();
  const headers = Object.fromEntries(response.headers.entries());
  const stored = { userId, opId, createdAt: Date.now(), status: response.status, headers, body };
  return { stored, response: new Response(body, { status: response.status, headers }) };
}

function sweepOpResults(results: Record<string, StoredOpResult>) {
  const cutoff = Date.now() - OP_RESULT_TTL_MS;
  for (const [key, result] of Object.entries(results)) {
    if (result.createdAt < cutoff) delete results[key];
  }
  pruneRecordMap(results, MAX_OP_RESULTS);
}

function ipSignal(request: Request) {
  return (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
}

function sweepRateLimits(db: AppDb) {
  const now = Date.now();
  for (const [key, bucket] of Object.entries(db.rateLimits)) {
    if (bucket.resetAt <= now) delete db.rateLimits[key];
  }
  const entries = Object.entries(db.rateLimits);
  if (entries.length <= RATE_LIMIT_MAX_BUCKETS) return;
  entries
    .sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, entries.length - RATE_LIMIT_MAX_BUCKETS)
    .forEach(([key]) => delete db.rateLimits[key]);
}

function checkRateLimit(db: AppDb, key: string, max: number, windowMs: number) {
  const now = Date.now();
  sweepRateLimits(db);
  const current = db.rateLimits[key];
  if (!current || current.resetAt <= now) {
    db.rateLimits[key] = { count: 1, resetAt: now + windowMs };
    return;
  }
  current.count += 1;
  if (current.count > max) throw new Error("Too many attempts. Try again soon.");
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

// Coerce a client-supplied recurrence into the strict Recurrence union.
// Unknown shapes fall back to {kind: "once"} — safer than throwing on
// malformed input, and the once-schedule flow was the pre-recurrence
// default anyway.
function validateRecurrence(value: unknown): Recurrence {
  if (!value || typeof value !== "object") return { kind: "once" };
  const v = value as { kind?: string; weekday?: number };
  if (v.kind === "daily") return { kind: "daily" };
  if (v.kind === "weekly" && typeof v.weekday === "number" && v.weekday >= 0 && v.weekday <= 6) {
    return { kind: "weekly", weekday: v.weekday as 0|1|2|3|4|5|6 };
  }
  return { kind: "once" };
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
      if (url.pathname === "/_auth/session") return await this.session(request);
      if (url.pathname === "/_internal/game-status" && request.method === "POST") return await this.updateGameStatus(request);
      if (url.pathname === "/_internal/call-invite" && request.method === "POST") return await this.callInvite(request);
      if (url.pathname === "/api/health") return json({ ok: true, pushTypes: PUSH_TYPES });
      if (url.pathname === "/api/push/policy") return json({ pushTypes: PUSH_TYPES });
      if (url.pathname === "/api/_client_error" && request.method === "POST") return await this.clientError(request);
      if (url.pathname === "/api/auth/register/options" && request.method === "POST") return await this.registrationOptions(request);
      if (url.pathname === "/api/auth/register/verify" && request.method === "POST") return await this.registrationVerify(request);
      if (url.pathname === "/api/auth/login/options" && request.method === "POST") return await this.loginOptions(request);
      if (url.pathname === "/api/auth/login/verify" && request.method === "POST") return await this.loginVerify(request);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return await this.logout(request);

      const user = await this.requireUser(request);
      const mutate = (event: string, entity: { kind: string; id: string }, fn: () => Promise<Response>) =>
        this.runMutation(request, user, event, entity, fn);
      if (url.pathname === "/api/me" && request.method === "GET") return await this.me(user);
      if (url.pathname === "/api/presence/heartbeat" && request.method === "POST") return await mutate("presence.heartbeat", { kind: "presence", id: user.id }, () => this.heartbeat(request, user));
      if (url.pathname === "/api/voice/ice-servers" && request.method === "GET") return await this.iceServers();
      if (url.pathname === "/api/push/subscribe" && request.method === "POST") return await mutate("push.subscribe", { kind: "user", id: user.id }, () => this.subscribe(request, user));
      if (url.pathname === "/api/push/pending" && request.method === "POST") return await mutate("push.pending", { kind: "user", id: user.id }, () => this.pendingPush(request, user));
      if (url.pathname === "/api/friends/request" && request.method === "POST") return await mutate("friend_request.create", { kind: "user", id: user.id }, () => this.requestFriend(request, user));
      if (url.pathname === "/api/friends/invite" && request.method === "POST") return await mutate("friend_invite.use", { kind: "user", id: user.id }, () => this.requestByInvite(request, user));
      if (url.pathname.match(/^\/api\/friends\/requests\/[^/]+$/) && request.method === "DELETE") {
        const id = url.pathname.split("/")[4];
        return await mutate("friend_request.withdraw", { kind: "friend_request", id }, () => this.withdrawFriendRequest(id, user));
      }
      if (url.pathname.match(/^\/api\/friends\/[^/]+\/accept$/) && request.method === "POST") {
        const id = url.pathname.split("/")[3];
        return await mutate("friend_request.accept", { kind: "friend_request", id }, () => this.acceptFriend(id, user));
      }
      if (url.pathname.match(/^\/api\/friends\/[^/]+\/decline$/) && request.method === "POST") {
        const id = url.pathname.split("/")[3];
        return await mutate("friend_request.decline", { kind: "friend_request", id }, () => this.declineFriendRequest(id, user));
      }
      if (url.pathname === "/api/challenges" && request.method === "POST") return await mutate("challenge.create", { kind: "user", id: user.id }, () => this.createChallenge(request, user));
      if (url.pathname.match(/^\/api\/challenges\/[^/]+\/accept$/) && request.method === "POST") {
        const id = url.pathname.split("/")[3];
        return await mutate("challenge.accept", { kind: "challenge", id }, () => this.acceptChallenge(id, user));
      }
      if (url.pathname.match(/^\/api\/challenges\/[^/]+\/withdraw$/) && request.method === "POST") {
        const id = url.pathname.split("/")[3];
        return await mutate("challenge.withdraw", { kind: "challenge", id }, () => this.withdrawChallenge(id, user));
      }
      if (url.pathname.match(/^\/api\/challenges\/[^/]+\/decline$/) && request.method === "POST") {
        const id = url.pathname.split("/")[3];
        return await mutate("challenge.decline", { kind: "challenge", id }, () => this.declineChallenge(id, user));
      }
      if (url.pathname.match(/^\/api\/challenges\/[^/]+\/state$/) && request.method === "GET") {
        return await this.challengeState(url.pathname.split("/")[3], user);
      }
      if (url.pathname === "/api/schedules" && request.method === "POST") return await mutate("schedule.create", { kind: "user", id: user.id }, () => this.createSchedule(request, user));
      if (url.pathname.match(/^\/api\/schedules\/[^/]+\/accept$/) && request.method === "POST") {
        const id = url.pathname.split("/")[3];
        return await mutate("schedule.accept", { kind: "schedule", id }, () => this.acceptSchedule(id, user));
      }
      if (url.pathname.match(/^\/api\/schedules\/[^/]+\/cancel$/) && request.method === "POST") {
        const id = url.pathname.split("/")[3];
        return await mutate("schedule.cancel", { kind: "schedule", id }, () => this.cancelSchedule(id, user));
      }
      if (url.pathname.match(/^\/api\/schedules\/[^/]+\/decline$/) && request.method === "POST") {
        const id = url.pathname.split("/")[3];
        return await mutate("schedule.decline", { kind: "schedule", id }, () => this.declineSchedule(id, user));
      }
      if (url.pathname === "/api/debug/push-log" && request.method === "GET") return await this.debugPushLog(request);
      if (url.pathname === "/api/debug/client-errors" && request.method === "GET") return await this.debugClientErrors(request);
      if (url.pathname === "/_debug/tick" && request.method === "POST") return await this.debugTick(request);

      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Request failed" }, { status: 400 });
    }
  }

  async alarm() {
    const db = await this.db();
    const now = Date.now();
    const pushIntents: PushDeliveryIntent[] = [];
    const gameInits: GameMeta[] = [];
    // Ensure legacy records without nextFireAt fall back to startAt on
    // the first alarm pass — the field was added when recurring
    // schedules shipped.
    for (const s of Object.values(db.schedules)) {
      if (s.status === "accepted" && s.nextFireAt === undefined) s.nextFireAt = s.startAt;
    }
    // GAP-7 zombie sweep (state-smith): a schedule that stays "pending"
    // past startAt + grace is unfireable and clutters both parties'
    // lists forever. Sweep to a new terminal "expired" (preserving the
    // record so the requester sees the outcome), NOT deleted. Grace of
    // 60s matches the "startAt within 60s of now" tolerance the create
    // endpoint accepts, so a proposal accepted seconds before startAt
    // isn't racy with the sweep.
    const ZOMBIE_GRACE_MS = 60_000;
    for (const s of Object.values(db.schedules)) {
      if (s.status === "pending" && s.startAt + ZOMBIE_GRACE_MS <= now) {
        s.status = "expired";
      }
    }
    const due = Object.values(db.schedules).filter(
      (s) => s.status === "accepted" && (s.nextFireAt ?? s.startAt) <= now,
    );
    for (const schedule of due) {
      // Create ONE fresh game per firing — always a new game even for
      // recurring, because each occurrence is a distinct playing session.
      const game = this.createGame(db, schedule.fromId, schedule.toId, schedule.timeControl, "schedule");
      gameInits.push(game);
      schedule.lastGameId = game.id;
      if (!schedule.gameId) schedule.gameId = game.id;   // preserve legacy field for the first firing
      // Human-first push copy (Tejas's iPhone-test order): put the OTHER
      // player's handle in the title so the notification reads as a person,
      // not a category. iOS renders this as the first line above "from
      // two chairs".
      const fromHandle = db.users[schedule.fromId]?.handle || "your friend";
      const toHandle = db.users[schedule.toId]?.handle || "your friend";
      pushIntents.push(this.enqueuePush(db, schedule.fromId, "scheduled_start", `Your game with @${toHandle} is starting`, `/game/${game.id}`));
      pushIntents.push(this.enqueuePush(db, schedule.toId,   "scheduled_start", `Your game with @${fromHandle} is starting`, `/game/${game.id}`));
      // Recurring schedules stay "accepted" and roll forward; one-offs
      // are done. Cap advance to a single interval per wake so a missed
      // week doesn't fire a stack of catch-up games — the loop below
      // then skips further past occurrences without firing them.
      const rec = recurrenceOf(schedule);
      if (rec.kind === "once") {
        schedule.status = "fired";
      } else {
        let next = advanceFireTime(schedule.nextFireAt ?? schedule.startAt, rec);
        // If we slept through multiple occurrences, skip forward to the
        // next FUTURE fire — only ONE catch-up game was created above.
        while (next <= now) next = advanceFireTime(next, rec);
        schedule.nextFireAt = next;
      }
    }
    await this.save(db);
    await this.setNextScheduleAlarm(db);
    for (const game of gameInits) this.ctx.waitUntil(this.initGame(game));
    for (const intent of pushIntents) this.ctx.waitUntil(this.deliverPush(intent));
  }

  private async db() {
    return normalizeDb(((await this.ctx.storage.get("db")) as AppDb | undefined) || emptyDb());
  }

  private save(db: AppDb) {
    return this.ctx.storage.put("db", db);
  }

  private async runMutation(
    request: Request,
    user: User,
    event: string,
    entity: { kind: string; id: string },
    fn: () => Promise<Response>,
  ) {
    const start = Date.now();
    const opId = clientOpId(request);
    const key = opId ? opKey(user.id, opId) : "";
    if (key) {
      const db = await this.db();
      sweepOpResults(db.opResults);
      const replay = db.opResults[key];
      if (replay) {
        this.logMutation({ event, actor: user.id, entity, outcome: "replayed", start });
        return responseFromStoredOp(replay);
      }
      await this.save(db);
    }
    try {
      const response = await fn();
      if (!key || !response.ok) {
        this.logMutation({ event, actor: user.id, entity, outcome: response.ok ? "ok" : "failed", start });
        return response;
      }
      const { stored, response: replayable } = await storeResponseForOp(response, user.id, opId);
      const db = await this.db();
      sweepOpResults(db.opResults);
      db.opResults[key] = stored;
      await this.save(db);
      this.logMutation({ event, actor: user.id, entity, outcome: "ok", start });
      return replayable;
    } catch (error) {
      this.logMutation({ event, actor: user.id, entity, outcome: "error", start, error });
      throw error;
    }
  }

  private logMutation({
    event,
    actor,
    entity,
    outcome,
    start,
    error,
  }: {
    event: string;
    actor?: string;
    entity: { kind: string; id: string };
    outcome: string;
    start: number;
    error?: unknown;
  }) {
    const entry: {
      level: "info" | "error";
      event: string;
      actor?: string;
      entity: { kind: string; id: string };
      outcome: string;
      latency_ms: number;
      error?: string;
    } = {
      level: error ? "error" : "info",
      event,
      actor,
      entity,
      outcome,
      latency_ms: Date.now() - start,
    };
    if (error) entry.error = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify(entry));
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

  private async clientError(request: Request) {
    const start = Date.now();
    const db = await this.db();
    const token = getCookie(request, COOKIE);
    const sessionUserId = token ? db.sessions[token] : undefined;
    const body = await readJson<{ url?: string; message?: string; stack?: string; userAgent?: string; userId?: string }>(request)
      .catch(() => ({} as { url?: string; message?: string; stack?: string; userAgent?: string; userId?: string }));
    const userId = body.userId && body.userId === sessionUserId ? body.userId : sessionUserId;
    db.clientErrors.push({
      id: newId("cer"),
      createdAt: Date.now(),
      url: String(body.url || "").slice(0, 500),
      message: String(body.message || "Client error").slice(0, 1_000),
      stack: body.stack ? String(body.stack).slice(0, 4_000) : undefined,
      userAgent: String(body.userAgent || request.headers.get("user-agent") || "").slice(0, 500),
      userId,
    });
    db.clientErrors = db.clientErrors.slice(-CLIENT_ERROR_LIMIT);
    await this.save(db);
    this.logMutation({ event: "client_error.record", actor: userId, entity: { kind: "client_error", id: "ring" }, outcome: "ok", start });
    return json({ ok: true });
  }

  private async registrationOptions(request: Request) {
    const start = Date.now();
    const db = await this.db();
    const { handle: rawHandle } = await readJson<{ handle: string }>(request);
    const handle = cleanHandle(rawHandle || "");
    assertHandle(handle);
    sweepExpiredChallenges(db);
    checkRateLimit(db, `register-options:${ipSignal(request)}:${handle}`, 12, 60_000);
    if (db.handleToUserId[handle]) {
      await this.save(db);
      this.logMutation({ event: "auth.registration_options", entity: { kind: "handle", id: handle }, outcome: "rejected", start });
      throw new Error("That handle is already taken.");
    }
    const userId = newId("usr");
    const { rpID } = rpInfo(request);
    const options = await generateRegistrationOptions({
      rpName: this.env.APP_NAME || "two chairs",
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
    this.logMutation({ event: "auth.registration_options", entity: { kind: "handle", id: handle }, outcome: "ok", start });
    return json(options);
  }

  private async registrationVerify(request: Request) {
    const start = Date.now();
    const db = await this.db();
    const url = new URL(request.url);
    const body = await readJson<{ handle: string; response: RegistrationResponseJSON }>(request);
    const handle = cleanHandle(body.handle || "");
    // Lazy TTL sweep (state-smith GAP-13): drop expired challenges on
    // every verify so accumulated ephemeral state doesn't grow
    // unbounded and won't ever be reused past its lifetime. Challenges
    // beyond CHALLENGE_TTL_MS (10 min) are unusable anyway — the
    // WebAuthn spec's own timeout is 60s.
    sweepExpiredChallenges(db);
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
    this.logMutation({ event: "auth.registration_verify", actor: user.id, entity: { kind: "user", id: user.id }, outcome: "ok", start });
    return json({ user: this.publicUser(user) }, { headers: { "set-cookie": sessionCookie(token, url) } });
  }

  private async loginOptions(request: Request) {
    const start = Date.now();
    const db = await this.db();
    const { handle: rawHandle } = await readJson<{ handle: string }>(request);
    const handle = cleanHandle(rawHandle || "");
    sweepExpiredChallenges(db);
    checkRateLimit(db, `login-options:${ipSignal(request)}:${handle}`, 12, 60_000);
    const userId = db.handleToUserId[handle];
    const user = userId ? db.users[userId] : undefined;
    if (!user) {
      await this.save(db);
      this.logMutation({ event: "auth.login_options", entity: { kind: "handle", id: handle || "(blank)" }, outcome: "rejected", start });
      throw new Error("No account with that handle.");
    }
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
    this.logMutation({ event: "auth.login_options", actor: user.id, entity: { kind: "user", id: user.id }, outcome: "ok", start });
    return json(options);
  }

  private async loginVerify(request: Request) {
    const start = Date.now();
    const db = await this.db();
    const url = new URL(request.url);
    const body = await readJson<{ handle: string; response: AuthenticationResponseJSON }>(request);
    const handle = cleanHandle(body.handle || "");
    const userId = db.handleToUserId[handle];
    const user = userId ? db.users[userId] : undefined;
    if (!user) throw new Error("No account with that handle.");
    // Lazy TTL sweep (state-smith GAP-13) — same story as registrationVerify.
    sweepExpiredChallenges(db);
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
    this.logMutation({ event: "auth.login_verify", actor: user.id, entity: { kind: "user", id: user.id }, outcome: "ok", start });
    return json({ user: this.publicUser(user) }, { headers: { "set-cookie": sessionCookie(token, url) } });
  }

  private async logout(request: Request) {
    const start = Date.now();
    const db = await this.db();
    const token = getCookie(request, COOKIE);
    const userId = token ? db.sessions[token] : undefined;
    if (token) delete db.sessions[token];
    await this.save(db);
    this.logMutation({ event: "auth.logout", actor: userId, entity: { kind: "session", id: token || "(none)" }, outcome: "ok", start });
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
          online: now - presenceSeenAt(db.presence[friend.id]) < PRESENCE_WINDOW_MS,
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
      // Filter out terminals that shouldn't clutter either party's list:
      // declined (invitee said no — GAP-6) and expired (pending past
      // grace, swept by alarm — GAP-7). Cancelled remains visible so
      // the ended-series row is discoverable; fired remains visible so
      // the played game is discoverable via the schedule bullet.
      .filter((schedule) => (schedule.toId === user.id || schedule.fromId === user.id) && schedule.status !== "declined" && schedule.status !== "expired")
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

  private async heartbeat(request: Request, user: User) {
    const db = await this.db();
    const body = await readJson<{ foregroundGameId?: string }>(request).catch(() => ({} as { foregroundGameId?: string }));
    const foregroundGameId = typeof body.foregroundGameId === "string" && /^gam_[A-Za-z0-9_-]+$/.test(body.foregroundGameId)
      ? body.foregroundGameId
      : undefined;
    db.presence[user.id] = { lastSeenAt: Date.now(), foregroundGameId };
    await this.save(db);
    return await this.me(user);
  }

  private async iceServers() {
    if (this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN) {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.env.TURN_KEY_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: 86_400 }),
      });
      if (!response.ok) throw new Error("Could not create voice credentials.");
      const body = await response.json() as { iceServers?: RTCIceServer[] };
      return json({ iceServers: body.iceServers || cloudflareStunOnly() });
    }
    return json({ iceServers: cloudflareStunOnly() });
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
    const body = await readJson<{ endpoint?: string; ackId?: string }>(request).catch(() => ({} as { endpoint?: string; ackId?: string }));
    const endpoint = body.endpoint || "";
    const ownsEndpoint = endpoint && (db.pushSubscriptions[user.id] || []).some((subscription) => subscription.endpoint === endpoint);
    if (body.ackId) {
      const beforeEndpoint = ownsEndpoint ? db.pendingPushesByEndpoint[endpoint] || [] : [];
      const beforeUser = db.pendingPushes[user.id] || [];
      if (ownsEndpoint) db.pendingPushesByEndpoint[endpoint] = beforeEndpoint.filter((pending) => pending.id !== body.ackId);
      db.pendingPushes[user.id] = beforeUser.filter((pending) => pending.id !== body.ackId);
      await this.save(db);
      return json({ ok: true });
    }
    const pending = ownsEndpoint ? db.pendingPushesByEndpoint[endpoint]?.[0] || null : db.pendingPushes[user.id]?.[0] || null;
    return json(pending);
  }

  private async requestFriend(request: Request, user: User) {
    const db = await this.db();
    const { handle: rawHandle } = await readJson<{ handle: string }>(request);
    const targetHandle = cleanHandle(rawHandle || "");
    const targetId = db.handleToUserId[targetHandle];
    const target = targetId ? db.users[targetId] : undefined;
    if (!target) throw new Error("No account with that handle.");
    return await this.createFriendRequest(db, user, target);
  }

  private async requestByInvite(request: Request, user: User) {
    // Invite-link semantics: the LINK IS the inviter's standing
    // consent, using it is the visitor's consent, two consents = a
    // friendship. No request/accept ceremony. Fully idempotent. The
    // request/accept dance stays ONLY for handle-search adds (see
    // requestFriend) where the target hasn't consented yet.
    //
    // Five cases per the ledger:
    //   1. Self-link → error (would be a friendship with yourself).
    //   2. Already friends → no-op success, returns { status: "already-friends" }.
    //   3. Pending request in either direction → accept it, friendship
    //      is created immediately, returns { status: "accepted" }.
    //   4. No relationship → create friendship immediately, returns
    //      { status: "created" }.
    //   5. Signed-out flow calls this AFTER auth completes with the
    //      preserved token — same code path from here.
    const db = await this.db();
    const { token } = await readJson<{ token: string }>(request);
    const target = Object.values(db.users).find((candidate) => candidate.inviteToken === token);
    if (!target) throw new Error("Invite link not found.");
    if (target.id === user.id) throw new Error("That's your own invite link.");
    const friendship = db.friendships[friendshipId(user.id, target.id)];
    if (friendship) {
      return json({ status: "already-friends", friend: { id: target.id, handle: target.handle } });
    }
    // Complete any pending request between the two (either direction).
    // Do this by mutation, not by calling acceptFriend — acceptFriend
    // only accepts requests where user.id === toId, but the pending
    // request could be OUTBOUND (user requested target earlier). The
    // invite link resolves both.
    const pending = Object.values(db.friendRequests).find(
      (req) =>
        req.status === "pending" &&
        ((req.fromId === user.id && req.toId === target.id) || (req.fromId === target.id && req.toId === user.id)),
    );
    if (pending) {
      pending.status = "accepted";
    }
    db.friendships[friendshipId(user.id, target.id)] = {
      id: friendshipId(user.id, target.id),
      userIds: [user.id, target.id],
      createdAt: Date.now(),
    };
    await this.save(db);
    return json({
      status: pending ? "accepted" : "created",
      friend: { id: target.id, handle: target.handle },
    });
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
    // Human-first title (Tejas's iPhone-test order): "@handle sent a friend request".
    const pushIntent = this.enqueuePush(db, target.id, "friend_request", `@${user.handle} sent a friend request`, "/");
    await this.save(db);
    this.ctx.waitUntil(this.deliverPush(pushIntent));
    return json({ request });
  }

  private async acceptFriend(id: string, user: User) {
    const db = await this.db();
    const request = db.friendRequests[id];
    if (!request || request.toId !== user.id) throw new Error("Friend request not available.");
    if (request.status === "pending") {
      request.status = "accepted";
      db.friendships[friendshipId(request.fromId, request.toId)] = {
        id: friendshipId(request.fromId, request.toId),
        userIds: [request.fromId, request.toId],
        createdAt: Date.now(),
      };
      await this.save(db);
    } else if (request.status !== "accepted" || !db.friendships[friendshipId(request.fromId, request.toId)]) {
      throw new Error("Friend request not available.");
    }
    return await this.me(user);
  }

  private async declineFriendRequest(id: string, user: User) {
    // Recipient-initiated no on a pending FriendRequest (state-smith
    // GAP-4). Only the toId may decline. Idempotent — a second decline
    // (or decline of an already-accepted/withdrawn request) is a no-op
    // success. Marks status="declined"; /api/me's `requests` filter
    // (status === "pending") drops it from the invitee's incoming list;
    // the sender's `sentRequests` (also status === "pending") drops it
    // too, so the outbound bullet clears on their next refresh.
    const db = await this.db();
    const request = db.friendRequests[id];
    if (!request) return json({ status: "gone" });
    if (request.toId !== user.id) throw new Error("Only the recipient can decline.");
    if (request.status === "pending") {
      request.status = "declined";
      await this.save(db);
    }
    return json({ status: request.status });
  }

  private async withdrawFriendRequest(id: string, user: User) {
    // Sender-initiated cancel of a pending FriendRequest (state-smith
    // GAP-5). Only the fromId may withdraw. Idempotent. Hard-deletes
    // the row — a request the sender took back leaves no trace on the
    // recipient side (no "@x wanted to be friends but changed their mind"
    // ghost). Contrast with challenge withdraw, which sets a terminal
    // status so the sender's WaitingRoom can display the outcome; a
    // friend-request sender has no dedicated waiting surface, so hard
    // delete is the simpler + correct shape.
    const db = await this.db();
    const request = db.friendRequests[id];
    if (!request) return json({ status: "gone" });
    if (request.fromId !== user.id) throw new Error("Only the sender can withdraw.");
    if (request.status !== "pending") return json({ status: request.status });
    delete db.friendRequests[id];
    await this.save(db);
    return json({ status: "withdrawn" });
  }

  private async createChallenge(request: Request, user: User) {
    const db = await this.db();
    const body = await readJson<{ friendId: string; timeControl?: TimeControl }>(request);
    const target = db.users[body.friendId];
    this.assertFriends(db, user.id, body.friendId);
    // Idempotent per state-smith GAP-3: dedupe any pending challenge
    // between the two users, in EITHER direction. Outbound pending →
    // return existing. Inbound pending (target invited caller first) →
    // reject with a specific error the client turns into "@x already
    // invited you — accept theirs." Mirrors the friend-request dedupe
    // pattern.
    for (const c of Object.values(db.challenges)) {
      if (c.status !== "pending") continue;
      if (c.fromId === user.id && c.toId === target.id) return json({ challenge: c });
      if (c.fromId === target.id && c.toId === user.id) throw new Error(`@${target.handle} already invited you — accept theirs instead.`);
    }
    const challenge: Challenge = {
      id: newId("chl"),
      fromId: user.id,
      toId: target.id,
      timeControl: validTimeControl(body.timeControl),
      status: "pending",
      createdAt: Date.now(),
    };
    db.challenges[challenge.id] = challenge;
    // Human-first title (Tejas's iPhone-test order): "@handle invited you to a game".
    const pushIntent = this.enqueuePush(db, target.id, "challenge", `@${user.handle} invited you to a game`, "/");
    await this.save(db);
    this.ctx.waitUntil(this.deliverPush(pushIntent));
    return json({ challenge });
  }

  private async withdrawChallenge(id: string, user: User) {
    // Sender-initiated cancel of an outstanding pending challenge. Only
    // the sender may withdraw. Idempotent — withdrawing an already-
    // withdrawn / declined / accepted challenge is a no-op success.
    // Sets status = "withdrawn" (per state-smith GAP-2) rather than
    // deleting so the WaitingRoom poll (GAP-14) can pick up the terminal
    // and show the sender the outcome before Home. `/api/me` filters to
    // status === "pending" so the row disappears from both dashboards.
    const db = await this.db();
    const challenge = db.challenges[id];
    if (!challenge) return json({ status: "gone" });
    if (challenge.fromId !== user.id) throw new Error("Only the inviter can withdraw.");
    if (challenge.status === "pending") {
      challenge.status = "withdrawn";
      await this.save(db);
    }
    return json({ status: challenge.status });
  }

  private async declineChallenge(id: string, user: User) {
    // Invitee-initiated no. Only the recipient may decline. Idempotent —
    // declining an already-declined / withdrawn / accepted challenge is a
    // no-op success. Sets status = "declined" (state-smith GAP-2). The
    // inviter's WaitingRoom poll picks up the terminal via
    // /api/challenges/:id/state and shows a Home button.
    const db = await this.db();
    const challenge = db.challenges[id];
    if (!challenge) return json({ status: "gone" });
    if (challenge.toId !== user.id) throw new Error("Only the invitee can decline.");
    if (challenge.status === "pending") {
      challenge.status = "declined";
      await this.save(db);
    }
    return json({ status: challenge.status });
  }

  private async acceptChallenge(id: string, user: User) {
    const db = await this.db();
    const challenge = db.challenges[id];
    if (!challenge || challenge.toId !== user.id) throw new Error("Challenge not available.");
    if (challenge.status === "accepted" && challenge.gameId && db.games[challenge.gameId]) {
      return json({ game: db.games[challenge.gameId] });
    }
    if (challenge.status !== "pending") throw new Error("Challenge not available.");
    const game = this.createGame(db, challenge.fromId, challenge.toId, challenge.timeControl, "challenge");
    challenge.status = "accepted";
    challenge.gameId = game.id;
    // Tell the inviter their handshake completed — they invited, went
    // back to their life, this brings them back to the ready game. The
    // realtime poll on /waiting/:id transitions them in-place if they
    // stayed at the table; the push covers the case where they left.
    const pushIntent = this.enqueuePush(db, challenge.fromId, "challenge_accepted", `@${user.handle} accepted — your game is ready`, `/game/${game.id}`);
    await this.save(db);
    await this.initGame(game);
    this.ctx.waitUntil(this.deliverPush(pushIntent));
    return json({ game });
  }

  private async challengeState(id: string, user: User) {
    // Sender's waiting-room poll target. Only the sender (or the invited
    // user) may read a challenge's state — no other user needs it. Enrich
    // with fromHandle/toHandle so the client can render the invitee's
    // handle without a second round-trip.
    const db = await this.db();
    const challenge = db.challenges[id];
    if (!challenge || (challenge.fromId !== user.id && challenge.toId !== user.id)) {
      throw new Error("Challenge not available.");
    }
    const enriched = {
      ...challenge,
      fromHandle: db.users[challenge.fromId]?.handle,
      toHandle: db.users[challenge.toId]?.handle,
    };
    return json({ challenge: enriched });
  }

  private async createSchedule(request: Request, user: User) {
    const db = await this.db();
    const body = await readJson<{ friendId: string; startAt: number; timeControl?: TimeControl; recurrence?: Recurrence }>(request);
    const target = db.users[body.friendId];
    this.assertFriends(db, user.id, body.friendId);
    const startAt = Number(body.startAt);
    if (!Number.isFinite(startAt) || startAt < Date.now() - 60000) throw new Error("Choose a future time.");
    const recurrence = validateRecurrence(body.recurrence);
    const schedule: Schedule = {
      id: newId("sch"),
      fromId: user.id,
      toId: target.id,
      timeControl: validTimeControl(body.timeControl),
      startAt,
      nextFireAt: startAt,
      recurrence,
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
    if (!schedule || schedule.toId !== user.id) throw new Error("Schedule not available.");
    if (schedule.status === "pending") {
      schedule.status = "accepted";
      // Ensure nextFireAt is set for records that came in without it.
      if (schedule.nextFireAt === undefined) schedule.nextFireAt = schedule.startAt;
      await this.save(db);
      await this.setNextScheduleAlarm(db);
    } else if (schedule.status !== "accepted" && schedule.status !== "fired") {
      throw new Error("Schedule not available.");
    }
    return json({ schedule });
  }

  private async declineSchedule(id: string, user: User) {
    // Recipient-initiated no on a pending Schedule proposal (state-smith
    // GAP-6). Only the toId may decline. Idempotent — decline of an
    // already-declined / cancelled / accepted / fired schedule is a
    // no-op success. Marks status="declined".
    const db = await this.db();
    const schedule = db.schedules[id];
    if (!schedule) return json({ status: "gone" });
    if (schedule.toId !== user.id) throw new Error("Only the recipient can decline.");
    if (schedule.status === "pending") {
      schedule.status = "declined";
      await this.save(db);
      await this.setNextScheduleAlarm(db);
    }
    return json({ status: schedule.status });
  }

  private async cancelSchedule(id: string, user: User) {
    // Either party can end the series. Cancels future firings; past
    // fired games remain playable (they're their own game objects).
    const db = await this.db();
    const schedule = db.schedules[id];
    if (!schedule) throw new Error("Schedule not found.");
    if (schedule.fromId !== user.id && schedule.toId !== user.id) throw new Error("Not your schedule.");
    if (schedule.status !== "accepted" && schedule.status !== "pending") {
      // Idempotent — a second cancel on an already-cancelled schedule
      // is a no-op, not an error.
      return json({ schedule });
    }
    schedule.status = "cancelled";
    schedule.cancelledBy = user.id;
    await this.save(db);
    await this.setNextScheduleAlarm(db);
    return json({ schedule });
  }

  private createGame(db: AppDb, whiteId: string, blackId: string, timeControl: TimeControl, source: GameMeta["source"]) {
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
    return game;
  }

  private async initGame(game: GameMeta) {
    const db = await this.db();
    const white = db.users[game.whiteId];
    const black = db.users[game.blackId];
    if (!white || !black) throw new Error("Cannot initialize game without both players.");
    const stub = this.env.GAME_DO.get(this.env.GAME_DO.idFromName(game.id));
    await stub.fetch("https://game.local/init", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal": "app" },
      body: JSON.stringify({
        id: game.id,
        whiteId: game.whiteId,
        blackId: game.blackId,
        whiteHandle: white.handle,
        blackHandle: black.handle,
        timeControl: game.timeControl,
      }),
    });
  }

  private assertFriends(db: AppDb, a: string, b: string) {
    if (!db.users[b]) throw new Error("Friend not found.");
    if (!db.friendships[friendshipId(a, b)]) throw new Error("You can only play friends.");
  }

  private enqueuePush(db: AppDb, userId: string, type: PushType, body: string, url: string): PushDeliveryIntent {
    if (!PUSH_TYPES.includes(type)) throw new Error("Push type is not allowed.");
    const pending: PendingPush = { id: newId("psh"), type, body, url, createdAt: Date.now() };
    db.pendingPushesByEndpoint ||= {};
    const subscriptions = db.pushSubscriptions[userId] || [];
    for (const subscription of subscriptions) {
      db.pendingPushesByEndpoint[subscription.endpoint] = [...(db.pendingPushesByEndpoint[subscription.endpoint] || []), pending].slice(-20);
    }
    if (subscriptions.length === 0) {
      db.pendingPushes[userId] = [...(db.pendingPushes[userId] || []), pending].slice(-20);
    }
    return { userId, pushId: pending.id };
  }

  private async deliverPush(intent: PushDeliveryIntent) {
    const snapshot = await this.db();
    const subscriptions = snapshot.pushSubscriptions[intent.userId] || [];
    const dead = new Set<string>();
    const logs: Array<{ type: PushType; userId: string; createdAt: number; delivered: boolean; status?: number }> = [];
    for (const subscription of subscriptions) {
      const type = snapshot.pendingPushesByEndpoint[subscription.endpoint]?.find((pending) => pending.id === intent.pushId)?.type;
      if (!type) continue;
      const result = await sendWebPush(subscription, this.env);
      logs.push({ type, userId: intent.userId, createdAt: Date.now(), delivered: result.delivered, status: result.status });
      if (result.status === 410 || result.status === 404) dead.add(subscription.endpoint);
    }
    if (subscriptions.length === 0) {
      const type = snapshot.pendingPushes[intent.userId]?.find((pending) => pending.id === intent.pushId)?.type;
      if (type) logs.push({ type, userId: intent.userId, createdAt: Date.now(), delivered: false });
    }
    const db = await this.db();
    if (dead.size) {
      db.pushSubscriptions[intent.userId] = subscriptions.filter((s) => !dead.has(s.endpoint));
      for (const endpoint of dead) delete db.pendingPushesByEndpoint[endpoint];
    }
    db.pushLog = [...db.pushLog, ...logs].slice(-100);
    await this.save(db);
  }

  private async callInvite(request: Request) {
    if (request.headers.get("x-internal") !== "game") throw new Error("Internal route.");
    const db = await this.db();
    const body = await readJson<{ gameId: string; initiatorId: string; recipientId: string }>(request);
    const game = db.games[body.gameId];
    if (!game || ![game.whiteId, game.blackId].includes(body.initiatorId) || ![game.whiteId, game.blackId].includes(body.recipientId)) {
      throw new Error("Call invite not available.");
    }
    const now = Date.now();
    const presence = db.presence[body.recipientId];
    const foreground = presenceForegroundGameId(presence) === body.gameId && now - presenceSeenAt(presence) < PRESENCE_WINDOW_MS;
    let pushIntent: PushDeliveryIntent | null = null;
    if (!foreground) {
      const initiator = db.users[body.initiatorId];
      pushIntent = this.enqueuePush(db, body.recipientId, "call_invite", `@${initiator?.handle || "your friend"} wants to talk`, `/game/${body.gameId}`);
    }
    await this.save(db);
    if (pushIntent) this.ctx.waitUntil(this.deliverPush(pushIntent));
    return json({ ok: true, pushed: !foreground });
  }

  private async setNextScheduleAlarm(db: AppDb) {
    // Consider two wake targets:
    //   1. next accepted schedule fires (nextFireAt)
    //   2. next pending schedule's zombie-sweep deadline (startAt + grace)
    // Take the earliest. Ensures GAP-7's expired-sweep runs promptly for
    // pending proposals that pass startAt without acceptance.
    const ZOMBIE_GRACE_MS = 60_000;
    const candidates: number[] = [];
    for (const s of Object.values(db.schedules)) {
      if (s.status === "accepted") candidates.push(s.nextFireAt ?? s.startAt);
      else if (s.status === "pending") candidates.push(s.startAt + ZOMBIE_GRACE_MS);
    }
    if (!candidates.length) return;
    const next = Math.min(...candidates);
    await this.ctx.storage.setAlarm(next);
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

  private async debugClientErrors(request: Request) {
    if (request.headers.get("x-debug-local") !== "true") throw new Error("Debug endpoint is local only.");
    const db = await this.db();
    return json({ clientErrors: db.clientErrors.slice(-CLIENT_ERROR_LIMIT) });
  }

  // Time-warp harness for alarm-driven behaviors (state-smith GAP-16).
  // Runs the alarm loop AS IF the current time were the `now` value in
  // the request body. Guarded by x-debug-local (same gate as
  // debugPushLog). Enables adversity tests for schedule zombie sweep
  // (GAP-7) and recurring alarm advancement without wall-clock waits.
  //
  // Behavior: fetch pending/accepted schedules, mutate their startAt /
  // nextFireAt so the alarm evaluates them at `now`, run alarm(), then
  // restore original timestamps on records that WEREN'T terminally
  // consumed (fired one-offs and expired zombies keep their new
  // terminal status; recurring accepteds get their nextFireAt rolled
  // back to what the alarm produced). Idempotent, isolated to schedules.
  private async debugTick(request: Request) {
    if (request.headers.get("x-debug-local") !== "true") throw new Error("Debug endpoint is local only.");
    const body = await readJson<{ now?: number }>(request).catch(() => ({} as { now?: number }));
    const target = typeof body.now === "number" ? body.now : Date.now();
    const db = await this.db();
    // Shift ONLY schedules relevant to the tick — pending zombies past
    // startAt, and accepted schedules whose nextFireAt is <= target.
    // We rewrite their timestamps to be <= now so alarm() picks them up
    // this tick, then remember originals for restoration.
    const now = Date.now();
    const originals: Record<string, { startAt: number; nextFireAt?: number }> = {};
    for (const s of Object.values(db.schedules)) {
      if (s.status === "pending" && s.startAt <= target) {
        originals[s.id] = { startAt: s.startAt, nextFireAt: s.nextFireAt };
        // Move startAt into the past so the alarm's zombie sweep fires.
        s.startAt = now - 120_000; // safely past 60s ZOMBIE_GRACE_MS
      } else if (s.status === "accepted" && (s.nextFireAt ?? s.startAt) <= target) {
        originals[s.id] = { startAt: s.startAt, nextFireAt: s.nextFireAt };
        s.nextFireAt = now - 1;
      }
    }
    await this.save(db);
    await this.alarm();
    return json({ tick: target, moved: Object.keys(originals).length });
  }

}

export class GameDO extends DurableObject<Env> {
  // State-smith GAP-8/9/11 (2026-08-04):
  //   - connectionState is DERIVED (not stored): active sockets +
  //     persisted graceExpiresAt tell us connected/reconnecting/gone.
  //     Previously an in-memory Map that vanished on hibernation,
  //     stranding both players in "gone" until the next event.
  //   - reconnect grace persisted as graceExpiresAt[userId] in storage
  //     and swept by alarm() — survives hibernation. setTimeout would
  //     silently die during an idle window.
  //   - Sockets use ctx.acceptWebSocket() (hibernatable API) with
  //     serializeAttachment for per-connection {userId, handle}. Event
  //     handlers move to class methods webSocketMessage / *Close /
  //     *Error so the DO can hibernate while sockets stay open.
  private static readonly GRACE_MS = 15_000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/init" && request.method === "POST") return await this.init(request);
      if (url.pathname === "/socket") return await this.socket(request);
      if (url.pathname === "/state") return await this.stateResponse();
      if (url.pathname === "/move" && request.method === "POST") return await this.move(request);
      if (url.pathname === "/resign" && request.method === "POST") return await this.resign(request);
      if (url.pathname === "/debug/expire" && request.method === "POST") return await this.debugExpire(request);
      if (url.pathname === "/debug/expire-grace" && request.method === "POST") return await this.debugExpireGrace(request);
      if (url.pathname === "/debug/call-expire" && request.method === "POST") return await this.debugCallExpire(request);
      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Game request failed" }, { status: 400 });
    }
  }

  // Hibernation-safe handlers (state-smith GAP-11). Cloudflare re-
  // instantiates the DO on wake and delivers events here instead of
  // to per-socket .addEventListener callbacks.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const data = typeof message === "string" ? message : "";
    if (data === "ping") {
      try { ws.send("pong"); } catch { /* close event will fire */ }
      return;
    }
    await this.handleSocketMessage(ws, data);
  }
  async webSocketClose(ws: WebSocket) { await this.disconnect(ws); }
  async webSocketError(ws: WebSocket) { await this.disconnect(ws); }

  async alarm() {
    const game = await this.game();
    if (!game) return;
    const now = Date.now();
    // Clock tick (only for active games).
    if (game.status === "active") {
      const changed = this.applyClock(game, now);
      if (changed) {
        await this.putGame(game);
        await this.reportStatus(game);
      }
    }
    // Grace sweep (state-smith GAP-9): promote users past their grace
    // deadline to "gone" if they still have no active socket. Broadcast
    // when the derived state changes so peers see the transition.
    const graces = await this.getGraces();
    let graceChanged = false;
    const active = this.activeUserIds();
    for (const [userId, expiresAt] of Object.entries(graces)) {
      if (expiresAt <= now && !active.has(userId)) {
        delete graces[userId];
        graceChanged = true;
      }
    }
    if (graceChanged) await this.ctx.storage.put("graceExpiresAt", graces);
    const sweptCall = await this.sweepCallAlarms(game, now);
    if (sweptCall) await this.broadcastFrom(game, sweptCall);
    else if (graceChanged || game.status !== "active") await this.broadcast();
    await this.setNextAlarm(game);
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
    await this.putGame(game);
    await this.setNextAlarm(game);
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
    // Hibernation-safe accept + attachment for {userId, handle}.
    // Attachment survives across DO hibernation cycles.
    server.serializeAttachment({ userId, handle });
    this.ctx.acceptWebSocket(server);
    // Reconnection clears any pending grace for this user.
    const graces = await this.getGraces();
    if (userId in graces) {
      delete graces[userId];
      await this.ctx.storage.put("graceExpiresAt", graces);
    }
    // Prime the newly-accepted socket with the current state directly —
    // ctx.getWebSockets() sometimes doesn't reflect a just-accepted
    // socket in the same request cycle (observed with wrangler dev),
    // and even in prod the reconnected client shouldn't have to wait
    // for the next event. Broadcast to the rest via the shared path.
    try {
      server.send(JSON.stringify({ type: "state", game: await this.snapshotFrom(game) }));
    } catch {
      /* if the just-accepted socket already died, close event fires and grace kicks in */
    }
    await this.broadcast();
    await this.setNextAlarm(game);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async stateResponse() {
    return json(await this.snapshot());
  }

  // Time-warp harness for the grace path (GAP-16 extension). Shifts
  // every graceExpiresAt entry into the past and immediately runs
  // alarm(), so an adversity test can prove alarm-driven promotion to
  // "gone" without waiting the full 15s wall-clock grace. Guarded by
  // x-debug-local: true — same gate as AppDO.debugTick / debugPushLog.
  // Idempotent, isolated to grace state (game clocks untouched).
  private async debugExpireGrace(request: Request) {
    if (request.headers.get("x-debug-local") !== "true") throw new Error("Debug endpoint is local only.");
    const graces = await this.getGraces();
    const past = Date.now() - 1_000;
    for (const userId of Object.keys(graces)) graces[userId] = past;
    await this.ctx.storage.put("graceExpiresAt", graces);
    await this.alarm();
    return json({ expired: Object.keys(graces).length });
  }

  private async debugCallExpire(request: Request) {
    if (request.headers.get("x-debug-local") !== "true") throw new Error("Debug endpoint is local only.");
    const session = await this.getCallSession();
    if (session && session.state !== "ended") {
      const now = Date.now();
      if (session.state === "requesting") session.startedAt = now - REQUEST_TIMEOUT_MS - 1_000;
      if (session.graceExpiresAt) session.graceExpiresAt = now - 1_000;
      await this.ctx.storage.put("callSession", session);
    }
    await this.alarm();
    return json({ callSession: await this.getCallSession() });
  }

  private async move(request: Request) {
    const userId = request.headers.get("x-user-id") || "";
    return await this.runGameMutation(request, userId, "game.move", async () => {
      return await this.performMove(request, userId);
    });
  }

  private async performMove(request: Request, userId: string) {
    const body = await readJson<{ from: string; to: string; promotion?: string }>(request);
    const game = await this.requirePlayer(userId);
    this.applyClock(game, Date.now());
    if (game.status !== "active") {
      await this.putGame(game);
      await this.reportStatus(game);
      await this.broadcast();
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
    if (game.status === "active") await this.setNextAlarm(game);
    else await this.reportStatus(game);
    await this.broadcast();
    return json(await this.snapshotFrom(game));
  }

  private async resign(request: Request) {
    const userId = request.headers.get("x-user-id") || "";
    return await this.runGameMutation(request, userId, "game.resign", async () => {
      return await this.performResign(userId);
    });
  }

  private async performResign(userId: string) {
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

  private async runGameMutation(request: Request, userId: string, event: string, fn: () => Promise<Response>) {
    const start = Date.now();
    const opId = clientOpId(request);
    const key = opId ? opKey(userId, opId) : "";
    if (key) {
      const results = await this.gameOpResults();
      sweepOpResults(results);
      const replay = results[key];
      if (replay) {
        await this.logGameMutation(event, userId, "replayed", start);
        return responseFromStoredOp(replay);
      }
      await this.ctx.storage.put("opResults", results);
    }
    try {
      const response = await fn();
      if (!key || !response.ok) {
        await this.logGameMutation(event, userId, response.ok ? "ok" : "failed", start);
        return response;
      }
      const { stored, response: replayable } = await storeResponseForOp(response, userId, opId);
      const results = await this.gameOpResults();
      sweepOpResults(results);
      results[key] = stored;
      await this.ctx.storage.put("opResults", results);
      await this.logGameMutation(event, userId, "ok", start);
      return replayable;
    } catch (error) {
      await this.logGameMutation(event, userId, "error", start, error);
      throw error;
    }
  }

  private async gameOpResults() {
    return ((await this.ctx.storage.get("opResults")) as Record<string, StoredOpResult> | undefined) || {};
  }

  private async logGameMutation(event: string, actor: string, outcome: string, start: number, error?: unknown) {
    const entityId = (await this.game())?.id || "(unknown)";
    const entry: {
      level: "info" | "error";
      event: string;
      actor: string;
      entity: { kind: string; id: string };
      outcome: string;
      latency_ms: number;
      error?: string;
    } = {
      level: error ? "error" : "info",
      event,
      actor,
      entity: { kind: "game", id: entityId },
      outcome,
      latency_ms: Date.now() - start,
    };
    if (error) entry.error = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify(entry));
  }

  private async debugExpire(request: Request) {
    const userId = request.headers.get("x-user-id") || "";
    const game = await this.requirePlayer(userId);
    if (game.status !== "active") return json(await this.snapshotFrom(game));
    const body = await readJson<{ ms?: number }>(request).catch(() => ({} as { ms?: number }));
    const ms = typeof body.ms === "number" && Number.isFinite(body.ms) ? Math.max(0, body.ms) : 250;
    if (game.turn === "w") game.whiteMs = ms;
    else game.blackMs = ms;
    game.lastTickAt = Date.now();
    await this.putGame(game);
    await this.setNextAlarm(game);
    await this.broadcast();
    return json(await this.snapshotFrom(game));
  }

  private async handleSocketMessage(ws: WebSocket, data: string) {
    const attachment = this.readAttachment(ws);
    if (!attachment) return;
    let message: { type?: unknown; callSessionId?: unknown; muted?: unknown; [key: string]: unknown };
    try {
      message = JSON.parse(data) as { type?: unknown; callSessionId?: unknown; muted?: unknown; [key: string]: unknown };
    } catch {
      await this.send(ws);
      return;
    }
    if (typeof message.type !== "string" || !message.type.startsWith("call-") && !message.type.startsWith("peer-")) {
      await this.send(ws);
      return;
    }
    const type = message.type;
    switch (type) {
      case "call-initiate":
        await this.callInitiate(attachment.userId);
        return;
      case "call-accept":
        await this.callAccept(attachment.userId, typeof message.callSessionId === "string" ? message.callSessionId : "");
        return;
      case "call-hangup":
        await this.callHangup(attachment.userId, typeof message.callSessionId === "string" ? message.callSessionId : undefined);
        return;
      case "call-mute":
        await this.callMute(attachment.userId, typeof message.callSessionId === "string" ? message.callSessionId : "", message.muted === true);
        return;
      case "peer-ice-connected":
        await this.peerIceConnected(attachment.userId, typeof message.callSessionId === "string" ? message.callSessionId : "");
        return;
      case "peer-ice-restart":
      case "peer-ice-disconnected":
        await this.peerIceDisconnected(attachment.userId, typeof message.callSessionId === "string" ? message.callSessionId : "");
        return;
      case "call-offer":
      case "call-answer":
      case "call-ice-candidate":
        await this.relayCallSignal(attachment.userId, message);
        return;
      default:
        return;
    }
  }

  private async callInitiate(userId: string) {
    const game = await this.requirePlayer(userId);
    if (game.status !== "active") {
      await this.sendToUser(userId, { type: "state", game: await this.snapshotFrom(game) });
      return;
    }
    const prev = await this.getCallSession();
    if (prev && prev.state !== "ended") {
      await this.sendToUser(userId, { type: "state", game: await this.snapshotFrom(game, prev) });
      return;
    }
    const next: CallSession = {
      id: crypto.randomUUID(),
      initiatorId: userId,
      state: "requesting",
      startedAt: Date.now(),
      muted: {},
    };
    await this.mutateCallSession(game, next, { broadcast: true });
    const recipientId = this.otherPlayerId(game, userId);
    this.ctx.waitUntil(this.enqueueCallInvite(game.id, userId, recipientId));
  }

  private async callAccept(userId: string, callSessionId: string) {
    const game = await this.requirePlayer(userId);
    const session = await this.getCurrentCallSession(callSessionId);
    if (!session || session.state !== "requesting" || session.initiatorId === userId) return;
    await this.mutateCallSession(game, {
      ...session,
      state: "connecting",
      acceptedAt: Date.now(),
    }, { broadcast: true });
  }

  private async callHangup(userId: string, callSessionId?: string) {
    const game = await this.requirePlayer(userId);
    const session = callSessionId ? await this.getCurrentCallSession(callSessionId) : await this.getCallSession();
    if (!session || session.state === "ended" || !this.isCallParticipant(game, userId, session)) return;
    await this.mutateCallSession(game, {
      ...session,
      state: "ended",
      endedAt: Date.now(),
      endReason: `hung-up-by-${userId}`,
      graceExpiresAt: undefined,
    }, { broadcast: true });
  }

  private async callMute(userId: string, callSessionId: string, muted: boolean) {
    const game = await this.requirePlayer(userId);
    const session = await this.getCurrentCallSession(callSessionId);
    if (!session || !this.isCallParticipant(game, userId, session)) return;
    if (session.state !== "connected" && session.state !== "reconnecting") return;
    if (session.muted[userId] === muted) return;
    await this.mutateCallSession(game, {
      ...session,
      muted: { ...session.muted, [userId]: muted },
    }, { broadcast: true });
  }

  private async peerIceConnected(userId: string, callSessionId: string) {
    const game = await this.requirePlayer(userId);
    const session = await this.getCurrentCallSession(callSessionId);
    if (!session || !this.isCallParticipant(game, userId, session)) return;
    if (session.state !== "connecting" && session.state !== "reconnecting") return;
    await this.mutateCallSession(game, {
      ...session,
      state: "connected",
      graceExpiresAt: undefined,
    }, { broadcast: true });
  }

  private async peerIceDisconnected(userId: string, callSessionId: string) {
    const game = await this.requirePlayer(userId);
    const session = await this.getCurrentCallSession(callSessionId);
    if (!session || !this.isCallParticipant(game, userId, session)) return;
    if (session.state !== "connected") return;
    await this.mutateCallSession(game, {
      ...session,
      state: "reconnecting",
      graceExpiresAt: Date.now() + CALL_GRACE_MS,
    }, { broadcast: true });
  }

  private async relayCallSignal(userId: string, message: { type?: unknown; callSessionId?: unknown; [key: string]: unknown }) {
    const game = await this.requirePlayer(userId);
    const callSessionId = typeof message.callSessionId === "string" ? message.callSessionId : "";
    const session = await this.getCurrentCallSession(callSessionId);
    if (!session || !this.isCallParticipant(game, userId, session) || session.state === "ended") return;
    await this.sendToUser(this.otherPlayerId(game, userId), { ...message, fromUserId: userId });
  }

  private async mutateCallSession(game: GameState, next: CallSession, options: { broadcast: boolean }) {
    await this.ctx.storage.put("callSession", next);
    await this.setNextAlarm(game, next);
    if (options.broadcast) await this.broadcastFrom(game, next);
  }

  private async sweepCallAlarms(game: GameState, now: number): Promise<CallSession | null> {
    const session = await this.getCallSession();
    if (!session || session.state === "ended") return null;
    if (session.state === "requesting" && now - session.startedAt >= REQUEST_TIMEOUT_MS) {
      const next: CallSession = {
        ...session,
        state: "ended",
        endedAt: now,
        endReason: "no-answer-timeout",
        graceExpiresAt: undefined,
      };
      await this.mutateCallSession(game, next, { broadcast: false });
      return next;
    }
    if (session.state === "reconnecting" && session.graceExpiresAt && session.graceExpiresAt <= now) {
      const next: CallSession = {
        ...session,
        state: "ended",
        endedAt: now,
        endReason: "peer-gone-timeout",
        graceExpiresAt: undefined,
      };
      await this.mutateCallSession(game, next, { broadcast: false });
      return next;
    }
    return null;
  }

  private async getCallSession(): Promise<CallSession | null> {
    return ((await this.ctx.storage.get("callSession")) as CallSession | undefined) || null;
  }

  private async getCurrentCallSession(callSessionId: string): Promise<CallSession | null> {
    const session = await this.getCallSession();
    if (!session || session.id !== callSessionId) return null;
    return session;
  }

  private isCallParticipant(game: GameState, userId: string, _session: CallSession): boolean {
    return game.whiteId === userId || game.blackId === userId;
  }

  private otherPlayerId(game: GameState, userId: string): string {
    return userId === game.whiteId ? game.blackId : game.whiteId;
  }

  private async enqueueCallInvite(gameId: string, initiatorId: string, recipientId: string) {
    const app = appStub(this.env);
    const res = await app.fetch("https://app.local/_internal/call-invite", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal": "game" },
      body: JSON.stringify({ gameId, initiatorId, recipientId }),
    });
    if (!res.ok) console.warn(`[GameDO ${gameId}] call invite failed: ${res.status}`);
  }

  private async disconnect(socket: WebSocket) {
    const attachment = this.readAttachment(socket);
    if (!attachment) return;
    const { userId } = attachment;
    // If the user still has ANOTHER live socket (multiple tabs), no
    // grace transition — they're still connected.
    const active = this.activeUserIds({ except: socket });
    if (active.has(userId)) {
      await this.broadcast();
      return;
    }
    // Set persisted grace. Alarm-driven promotion to "gone" survives
    // DO hibernation, unlike the previous setTimeout (state-smith GAP-9).
    // 15s grace — iOS Safari can take 5-10s to reconnect after URL bar
    // hide/show or tab switch.
    const graces = await this.getGraces();
    graces[userId] = Date.now() + GameDO.GRACE_MS;
    await this.ctx.storage.put("graceExpiresAt", graces);
    const game = await this.game();
    if (!game) {
      await this.broadcast();
      return;
    }
    const session = await this.getCallSession();
    if (session && this.isCallParticipant(game, userId, session) && (session.state === "connected" || session.state === "connecting")) {
      const next: CallSession = {
        ...session,
        state: "reconnecting",
        graceExpiresAt: Date.now() + CALL_GRACE_MS,
      };
      await this.mutateCallSession(game, next, { broadcast: true });
    } else {
      await this.broadcast();
      await this.setNextAlarm(game);
    }
  }

  // Persisted grace map lookup — returns {} when unset. Storage backs
  // this so a hibernated DO wakes with the same view.
  private async getGraces(): Promise<Record<string, number>> {
    return ((await this.ctx.storage.get("graceExpiresAt")) as Record<string, number> | undefined) || {};
  }

  // Set of userIds that currently have at least one live socket
  // attached. Uses the hibernation-API getWebSockets() instead of a
  // manual in-memory Map so this survives DO hibernation.
  private activeUserIds(opts: { except?: WebSocket } = {}): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (opts.except && ws === opts.except) continue;
      const att = this.readAttachment(ws);
      if (att) ids.add(att.userId);
    }
    return ids;
  }

  private readAttachment(ws: WebSocket): { userId: string; handle: string } | null {
    const raw = (ws as unknown as { deserializeAttachment?: () => unknown }).deserializeAttachment?.();
    if (!raw || typeof raw !== "object") return null;
    const record = raw as { userId?: unknown; handle?: unknown };
    if (typeof record.userId !== "string" || typeof record.handle !== "string") return null;
    return { userId: record.userId, handle: record.handle };
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
    return await this.snapshotFrom(game);
  }

  private async snapshotFrom(game: GameState, callSession?: CallSession | null) {
    return {
      ...game,
      connectionState: await this.computeConnectionState(game),
      callSession: callSession === undefined ? await this.getCallSession() : callSession,
    };
  }

  // Derive per-player connection state at snapshot time from live
  // sockets + persisted grace. Replaces the in-memory Map that couldn't
  // survive hibernation (state-smith GAP-8).
  private async computeConnectionState(game: GameState) {
    const now = Date.now();
    const active = this.activeUserIds();
    const graces = await this.getGraces();
    const stateFor = (userId: string): "connected" | "reconnecting" | "gone" => {
      if (active.has(userId)) return "connected";
      const grace = graces[userId];
      if (grace && grace > now) return "reconnecting";
      return "gone";
    };
    return { [game.whiteId]: stateFor(game.whiteId), [game.blackId]: stateFor(game.blackId) };
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

  // Wake at the earliest of (a) clock tick deadline for an active game
  // and (b) the nearest graceExpiresAt. Combined so a single alarm
  // handles both concerns without either starving the other
  // (state-smith GAP-9 alignment).
  private async setNextAlarm(game: GameState, callSession?: CallSession | null) {
    const now = Date.now();
    const wakes: number[] = [];
    if (game.status === "active") {
      const remaining = game.turn === "w" ? game.whiteMs : game.blackMs;
      wakes.push(now + Math.max(100, remaining));
    }
    const graces = await this.getGraces();
    for (const at of Object.values(graces)) wakes.push(Math.max(now + 100, at));
    const session = callSession === undefined ? await this.getCallSession() : callSession;
    if (session?.state === "requesting") wakes.push(Math.max(now + 100, session.startedAt + REQUEST_TIMEOUT_MS));
    if (session?.state === "reconnecting" && session.graceExpiresAt) wakes.push(Math.max(now + 100, session.graceExpiresAt));
    if (!wakes.length) return;
    await this.ctx.storage.setAlarm(Math.min(...wakes));
  }

  // reportStatus wraps AppDO update with retry (state-smith GAP-10).
  // The AppDO write is idempotent (setting the same status twice is a
  // no-op), so retry is safe. Backoff caps at ~5 attempts / ~5s so a
  // transient failure doesn't strand the AppDO's `games[id].status`
  // projection as "active" after the game has ended. Runs in the
  // background via ctx.waitUntil so the caller isn't blocked; the DO
  // stays warm for the full retry window.
  private async reportStatus(game: GameState) {
    const env = this.env;
    const payload = JSON.stringify({ id: game.id, status: game.status, result: game.result });
    const attempt = async (n: number): Promise<void> => {
      try {
        const app = appStub(env);
        const res = await app.fetch("https://app.local/_internal/game-status", {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal": "game" },
          body: payload,
        });
        if (!res.ok) throw new Error(`AppDO returned ${res.status}`);
      } catch (error) {
        if (n >= 5) {
          console.warn(`[GameDO ${game.id}] reportStatus giving up after ${n} attempts:`, error);
          return;
        }
        const wait = Math.min(5_000, 250 * 2 ** (n - 1));
        await new Promise((r) => setTimeout(r, wait));
        await attempt(n + 1);
      }
    };
    // Kick off the first attempt synchronously so the common-case
    // success completes before the caller returns; retries run detached.
    this.ctx.waitUntil(attempt(1));
  }

  private async send(socket: WebSocket) {
    socket.send(JSON.stringify({ type: "state", game: await this.snapshot() }));
  }

  private async broadcast() {
    const game = await this.game();
    if (!game) return;
    await this.broadcastFrom(game);
  }

  private async broadcastFrom(game: GameState, callSession?: CallSession | null) {
    const message = JSON.stringify({ type: "state", game: await this.snapshotFrom(game, callSession) });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); } catch { /* dead socket → close event fires */ }
    }
  }

  private async sendToUser(userId: string, payload: unknown) {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.readAttachment(ws);
      if (att?.userId !== userId) continue;
      try { ws.send(message); } catch { /* dead socket → close event fires */ }
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
    if (url.pathname === "/api/debug/push-log" || url.pathname === "/api/debug/client-errors" || url.pathname === "/_debug/tick") {
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return json({ error: "Not found" }, { status: 404 });
      const headers = new Headers(request.headers);
      headers.set("x-debug-local", "true");
      return appStub(env).fetch(await requestForDo(new Request(request, { headers })));
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_auth/")) return appStub(env).fetch(await requestForDo(request));

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return withCacheHeaders(asset, url.pathname);
    // SPA fallback for client-side routes — always the HTML shell, which
    // must revalidate on every load so a deploy reaches phones on next
    // reload (Tejas's Safari served the old notice UI post-toast-deploy).
    const indexUrl = new URL("/", request.url);
    const shell = await env.ASSETS.fetch(new Request(indexUrl, request));
    return withCacheHeaders(shell, "/");
  },
};

// Cache policy — Workers Assets defaults to `max-age=0, must-revalidate`
// on everything, but Safari (esp. inside a PWA / from a home-screen
// launch) treats that as "cache aggressively with heuristics" without an
// explicit `no-cache`. Explicit `no-cache` forces the revalidation to
// happen. Hashed bundles under /assets/* are content-addressed, so they
// can cache forever with `immutable`.
function withCacheHeaders(res: Response, pathname: string): Response {
  const headers = new Headers(res.headers);
  const isImmutable = pathname.startsWith("/assets/");
  headers.set(
    "Cache-Control",
    isImmutable
      ? "public, max-age=31536000, immutable"
      : "no-cache, must-revalidate",
  );
  if (!isImmutable) headers.set("Pragma", "no-cache");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
