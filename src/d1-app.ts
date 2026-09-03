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

export type PushType = "friend_request" | "challenge" | "challenge_accepted" | "scheduled_start" | "call_invite";
export type TimeControl = "10|0" | "5|0";
export type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";
export type Recurrence =
  | { kind: "once" }
  | { kind: "weekly"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "daily" };

interface ObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

export interface D1AppEnv {
  APP_NAME: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  DB: D1Database;
  GAME_DO: ObjectNamespace;
  SCHEDULER_DO: ObjectNamespace;
}

export interface PublicUser {
  id: string;
  handle: string;
}

interface UserRow {
  id: string;
  handle: string;
  invite_token: string;
  created_at: number;
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports_json: string;
}

interface AuthChallengeRow {
  id: string;
  purpose: "registration" | "authentication";
  handle: string | null;
  user_id: string | null;
  provisional_user_id: string | null;
  challenge: string;
  created_at: number;
  expires_at: number;
}

interface FriendRequestRow {
  id: string;
  from_id: string;
  to_id: string;
  status: "pending" | "accepted" | "declined";
  created_at: number;
  from_handle?: string;
  to_handle?: string;
}

interface ChallengeRow {
  id: string;
  from_id: string;
  to_id: string;
  time_control: TimeControl;
  status: "pending" | "accepted" | "declined" | "withdrawn";
  game_id: string | null;
  created_at: number;
  from_handle?: string;
  to_handle?: string;
}

interface ScheduleRow {
  id: string;
  from_id: string;
  to_id: string;
  time_control: TimeControl;
  start_at: number;
  next_fire_at: number;
  recurrence_kind: "once" | "daily" | "weekly";
  recurrence_weekday: number | null;
  status: "pending" | "accepted" | "fired" | "declined" | "cancelled" | "expired";
  game_id: string | null;
  last_game_id: string | null;
  cancelled_by: string | null;
  created_at: number;
  from_handle?: string;
  to_handle?: string;
}

export interface GameRow {
  id: string;
  white_id: string;
  black_id: string;
  white_handle?: string;
  black_handle?: string;
  time_control: TimeControl;
  source: "challenge" | "schedule" | "rematch";
  status: GameStatus;
  result: string | null;
  created_at: number;
  projection_updated_at: number;
  initialized_at: number | null;
  init_attempts: number;
  init_retry_at: number | null;
  init_error: string | null;
}

interface PendingPushRow {
  id: string;
  event_key: string;
  user_id: string;
  endpoint: string;
  type: PushType;
  body: string;
  url: string;
  created_at: number;
  expires_at: number;
  delivery_attempts: number;
  next_attempt_at: number;
  keys_json?: string;
  expiration_time?: number | null;
}

interface StoredSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys?: Record<string, string>;
}

interface IdempotencyRow {
  status: number;
  headers_json: string;
  body: string;
}

export interface ScheduleOccurrenceRow {
  occurrence_key: string;
  schedule_id: string;
  scheduled_for: number;
  game_id: string;
  claimed_at: number;
  game_initialized_at: number | null;
  from_push_enqueued_at: number | null;
  to_push_enqueued_at: number | null;
  effects_completed_at: number | null;
  attempts: number;
  retry_at: number;
  last_error: string | null;
  from_id: string;
  to_id: string;
  time_control: TimeControl;
  from_handle: string;
  to_handle: string;
}

const COOKIE = "cwf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_PUSH_TTL_MS = 5 * 60 * 1000;
const ONLINE_WINDOW_MS = 75_000;
const FOREGROUND_WINDOW_MS = 30_000;
const PRESENCE_STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEDULE_PENDING_GRACE_MS = 60_000;
const SCHEDULER_WATCHDOG_MS = 60_000;
const SCHEDULER_BATCH_SIZE = 25;
const PUSH_TYPES: PushType[] = ["friend_request", "challenge", "challenge_accepted", "scheduled_start", "call_invite"];

function keepsIdempotencyResult(pathname: string, method: string) {
  if (method === "GET" || method === "HEAD") return false;
  return pathname.startsWith("/api/friends/")
    || pathname === "/api/challenges"
    || /^\/api\/challenges\/[^/]+\/(accept|withdraw|decline)$/.test(pathname)
    || pathname === "/api/schedules"
    || /^\/api\/schedules\/[^/]+\/(accept|cancel|decline)$/.test(pathname)
    || pathname === "/api/push/subscribe"
    || pathname === "/api/push/unsubscribe";
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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
    throw new HttpError("Handles use 3-20 lowercase letters, numbers, or underscores.", 400);
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
  return { rpID: url.hostname, origin: `${url.protocol}//${url.host}` };
}

function validTimeControl(value: unknown): TimeControl {
  return value === "5|0" ? "5|0" : "10|0";
}

function validateRecurrence(value: unknown): Recurrence {
  if (!value || typeof value !== "object") return { kind: "once" };
  const recurrence = value as { kind?: string; weekday?: number };
  if (recurrence.kind === "daily") return { kind: "daily" };
  if (recurrence.kind === "weekly" && Number.isInteger(recurrence.weekday) && recurrence.weekday! >= 0 && recurrence.weekday! <= 6) {
    return { kind: "weekly", weekday: recurrence.weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6 };
  }
  return { kind: "once" };
}

function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function friendshipId(a: string, b: string) {
  return pair(a, b).join(":");
}

function clientOpId(request: Request) {
  const value = request.headers.get("x-client-op-id") || request.headers.get("x-op-id") || "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "";
}

function ipSignal(request: Request) {
  return (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
}

async function sha256(value: string) {
  return isoBase64URL.fromBuffer(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function changes(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes || 0);
}

function d1Usage(results: D1Result<unknown>[]) {
  return results.reduce((usage, result) => {
    const meta = result.meta as D1Result<unknown>["meta"] & { rows_read?: number; rows_written?: number };
    usage.rowsRead += Number(meta?.rows_read || 0);
    usage.rowsWritten += Number(meta?.rows_written || 0);
    return usage;
  }, { rowsRead: 0, rowsWritten: 0 });
}

function publicUser(user: UserRow) {
  return { id: user.id, handle: user.handle, inviteToken: user.invite_token };
}

function friendRequest(row: FriendRequestRow) {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.from_handle ? { fromHandle: row.from_handle } : {}),
    ...(row.to_handle ? { toHandle: row.to_handle } : {}),
  };
}

function challenge(row: ChallengeRow) {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    timeControl: row.time_control,
    status: row.status,
    ...(row.game_id ? { gameId: row.game_id } : {}),
    createdAt: row.created_at,
    ...(row.from_handle ? { fromHandle: row.from_handle } : {}),
    ...(row.to_handle ? { toHandle: row.to_handle } : {}),
  };
}

function schedule(row: ScheduleRow) {
  const recurrence: Recurrence = row.recurrence_kind === "weekly"
    ? { kind: "weekly", weekday: row.recurrence_weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6 }
    : { kind: row.recurrence_kind };
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    timeControl: row.time_control,
    startAt: row.start_at,
    nextFireAt: row.next_fire_at,
    recurrence,
    status: row.status,
    ...(row.game_id ? { gameId: row.game_id } : {}),
    ...(row.last_game_id ? { lastGameId: row.last_game_id } : {}),
    ...(row.cancelled_by ? { cancelledBy: row.cancelled_by } : {}),
    createdAt: row.created_at,
    ...(row.from_handle ? { fromHandle: row.from_handle } : {}),
    ...(row.to_handle ? { toHandle: row.to_handle } : {}),
  };
}

function game(row: GameRow) {
  return {
    id: row.id,
    whiteId: row.white_id,
    blackId: row.black_id,
    timeControl: row.time_control,
    source: row.source,
    status: row.status,
    ...(row.result ? { result: row.result } : {}),
    createdAt: row.created_at,
  };
}

function pendingPush(row: PendingPushRow) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    body: row.body,
    url: row.url,
    createdAt: row.created_at,
  };
}

async function cleanupBounded(db: D1Database, now = Date.now()) {
  await db.batch([
    db.prepare("DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)").bind(now),
    db.prepare("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL ORDER BY expires_at LIMIT 100)").bind(now),
    db.prepare("DELETE FROM presence_leases WHERE lease_key IN (SELECT lease_key FROM presence_leases WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)").bind(now),
    db.prepare("DELETE FROM pending_pushes WHERE id IN (SELECT id FROM pending_pushes WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)").bind(now),
    db.prepare("DELETE FROM idempotency_results WHERE result_key IN (SELECT result_key FROM idempotency_results WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE reset_at <= ? ORDER BY reset_at LIMIT 100)").bind(now),
  ]);
}

async function checkRateLimit(db: D1Database, key: string, max: number, windowMs: number) {
  const now = Date.now();
  const row = await db.prepare(`
    INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
    RETURNING count
  `).bind(key, now + windowMs, now, now).first<{ count: number }>();
  // Preserve the existing public API contract: AppDO surfaced all rejected
  // auth-option probes as 400 responses, including rate-limit rejection.
  if (!row || row.count > max) throw new HttpError("Too many attempts. Try again soon.", 400);
}

async function responseFromIdempotency(db: D1Database, userId: string, opId: string) {
  if (!opId) return null;
  const stored = await db.prepare(
    "SELECT status, headers_json, body FROM idempotency_results WHERE user_id = ? AND op_id = ? AND expires_at > ?",
  ).bind(userId, opId, Date.now()).first<IdempotencyRow>();
  if (!stored) return null;
  return new Response(stored.body, { status: stored.status, headers: JSON.parse(stored.headers_json) as Record<string, string> });
}

async function storeIdempotencyResponse(db: D1Database, userId: string, opId: string, response: Response) {
  if (!opId || !response.ok) return response;
  const body = await response.clone().text();
  const headers = Object.fromEntries(response.headers.entries());
  const now = Date.now();
  await db.prepare(`
    INSERT OR IGNORE INTO idempotency_results
      (result_key, user_id, op_id, status, headers_json, body, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(`${userId}:${opId}`, userId, opId, response.status, JSON.stringify(headers), body, now, now + IDEMPOTENCY_TTL_MS).run();
  return new Response(body, { status: response.status, headers });
}

function logMutation(event: string, actor: string | undefined, entity: { kind: string; id: string }, outcome: string, start: number, error?: unknown) {
  console.log(JSON.stringify({
    level: error ? "error" : "info",
    event,
    actor,
    entity,
    outcome,
    latency_ms: Date.now() - start,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  }));
}

async function requestForDo(request: Request, url: string) {
  const headers = new Headers(request.headers);
  headers.delete("x-internal");
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.text();
  return new Request(url, init);
}

function schedulerStub(env: D1AppEnv) {
  return env.SCHEDULER_DO.get(env.SCHEDULER_DO.idFromName("scheduler"));
}

async function tellScheduler(env: D1AppEnv, path: string, body: unknown = {}) {
  const response = await schedulerStub(env).fetch(`https://scheduler.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal": "worker" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new HttpError(`Scheduler ${path} failed.`, 503);
  return response;
}

export async function currentD1User(request: Request, env: D1AppEnv): Promise<PublicUser | null> {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT u.id, u.handle
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
  `).bind(tokenHash, Date.now()).first<PublicUser>();
  return row || null;
}

async function requireUserRow(request: Request, env: D1AppEnv) {
  const token = getCookie(request, COOKIE);
  if (!token) throw new HttpError("Sign in first.", 401);
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
  `).bind(tokenHash, Date.now()).first<UserRow>();
  if (!user) throw new HttpError("Sign in first.", 401);
  return { user, tokenHash };
}

export async function handleD1AppRequest(request: Request, env: D1AppEnv, execution: ExecutionContext): Promise<Response> {
  const app = new D1Application(env, execution);
  return app.fetch(request);
}

class D1Application {
  constructor(private readonly env: D1AppEnv, private readonly execution: ExecutionContext) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const startedAt = Date.now();
    const isMutation = request.method !== "GET" && request.method !== "HEAD";
    let actorId: string | undefined;
    try {
      if (url.pathname === "/api/health" && request.method === "GET") return await this.health();
      if (url.pathname === "/api/push/policy" && request.method === "GET") return json({ pushTypes: PUSH_TYPES });
      if (url.pathname === "/api/_client_error" && request.method === "POST") return await this.clientError(request);
      if (url.pathname === "/api/auth/register/options" && request.method === "POST") return await this.registrationOptions(request);
      if (url.pathname === "/api/auth/register/verify" && request.method === "POST") return await this.registrationVerify(request);
      if (url.pathname === "/api/auth/login/options" && request.method === "POST") return await this.loginOptions(request);
      if (url.pathname === "/api/auth/login/verify" && request.method === "POST") return await this.loginVerify(request);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return await this.logout(request);
      if (url.pathname === "/_auth/session" && request.method === "GET") return await this.session(request);
      if (url.pathname === "/_debug/reset-app" && request.method === "POST") return await this.debugReset(request);

      const { user, tokenHash } = await requireUserRow(request, this.env);
      actorId = user.id;
      const opId = keepsIdempotencyResult(url.pathname, request.method) ? clientOpId(request) : "";
      const replay = await responseFromIdempotency(this.env.DB, user.id, opId);
      if (replay) return replay;

      let response: Response;
      if (url.pathname === "/api/me" && request.method === "GET") response = await this.me(user);
      else if (url.pathname === "/api/presence/heartbeat" && request.method === "POST") response = await this.heartbeat(request, user, tokenHash);
      else if (url.pathname === "/api/voice/ice-servers" && request.method === "GET") response = await this.iceServers();
      else if (url.pathname === "/api/push/subscribe" && request.method === "POST") response = await this.subscribe(request, user);
      else if (url.pathname === "/api/push/unsubscribe" && request.method === "POST") response = await this.unsubscribe(request, user);
      else if (url.pathname === "/api/push/pending" && request.method === "POST") response = await this.readPendingPush(request, user);
      else if (url.pathname === "/api/friends/request" && request.method === "POST") response = await this.requestFriend(request, user);
      else if (url.pathname === "/api/friends/invite" && request.method === "POST") response = await this.requestByInvite(request, user);
      else if (url.pathname.match(/^\/api\/friends\/requests\/[^/]+$/) && request.method === "DELETE") response = await this.withdrawFriendRequest(url.pathname.split("/")[4], user);
      else if (url.pathname.match(/^\/api\/friends\/[^/]+\/accept$/) && request.method === "POST") response = await this.acceptFriend(url.pathname.split("/")[3], user);
      else if (url.pathname.match(/^\/api\/friends\/[^/]+\/decline$/) && request.method === "POST") response = await this.declineFriendRequest(url.pathname.split("/")[3], user);
      else if (url.pathname === "/api/challenges" && request.method === "POST") response = await this.createChallenge(request, user);
      else if (url.pathname.match(/^\/api\/challenges\/[^/]+\/accept$/) && request.method === "POST") response = await this.acceptChallenge(url.pathname.split("/")[3], user);
      else if (url.pathname.match(/^\/api\/challenges\/[^/]+\/withdraw$/) && request.method === "POST") response = await this.withdrawChallenge(url.pathname.split("/")[3], user);
      else if (url.pathname.match(/^\/api\/challenges\/[^/]+\/decline$/) && request.method === "POST") response = await this.declineChallenge(url.pathname.split("/")[3], user);
      else if (url.pathname.match(/^\/api\/challenges\/[^/]+\/state$/) && request.method === "GET") response = await this.challengeState(url.pathname.split("/")[3], user);
      else if (url.pathname === "/api/schedules" && request.method === "POST") response = await this.createSchedule(request, user);
      else if (url.pathname.match(/^\/api\/schedules\/[^/]+\/accept$/) && request.method === "POST") response = await this.acceptSchedule(url.pathname.split("/")[3], user);
      else if (url.pathname.match(/^\/api\/schedules\/[^/]+\/cancel$/) && request.method === "POST") response = await this.cancelSchedule(url.pathname.split("/")[3], user);
      else if (url.pathname.match(/^\/api\/schedules\/[^/]+\/decline$/) && request.method === "POST") response = await this.declineSchedule(url.pathname.split("/")[3], user);
      else if (url.pathname === "/api/debug/push-log" && request.method === "GET") response = await this.debugPushLog(request);
      else if (url.pathname === "/api/debug/client-errors" && request.method === "GET") response = await this.debugClientErrors(request);
      else if (url.pathname === "/api/debug/db-stats" && request.method === "GET") response = await this.debugDbStats(request);
      else if (url.pathname === "/_debug/tick" && request.method === "POST") response = await this.debugTick(request);
      else throw new HttpError("Not found", 404);

      const storedResponse = await storeIdempotencyResponse(this.env.DB, user.id, opId, response);
      if (isMutation) {
        logMutation("d1.route", user.id, { kind: "route", id: url.pathname }, `http_${storedResponse.status}`, startedAt);
      }
      return storedResponse;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (isMutation) {
        logMutation("d1.route", actorId, { kind: "route", id: url.pathname }, `http_${status}`, startedAt, error);
      }
      return json({ error: error instanceof Error ? error.message : "Request failed" }, { status });
    }
  }

  private async health() {
    const result = await this.env.DB.prepare("SELECT COUNT(*) AS users FROM users").first<{ users: number }>();
    return json({ ok: typeof result?.users === "number", storage: "d1", pushTypes: PUSH_TYPES });
  }

  private async session(request: Request) {
    const user = await currentD1User(request, this.env);
    return user ? json(user) : json({ error: "No session" }, { status: 401 });
  }

  private async clientError(request: Request) {
    const start = Date.now();
    const sessionUser = await currentD1User(request, this.env).catch(() => null);
    const body = await readJson<{ url?: string; message?: string; stack?: string; userAgent?: string; userId?: string }>(request)
      .catch(() => ({} as { url?: string; message?: string; stack?: string; userAgent?: string; userId?: string }));
    const userId = body.userId === sessionUser?.id ? body.userId : sessionUser?.id;
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare(`
        INSERT INTO client_errors (id, created_at, url, message, stack, user_agent, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        newId("cer"),
        now,
        String(body.url || "").slice(0, 500),
        String(body.message || "Client error").slice(0, 1_000),
        body.stack ? String(body.stack).slice(0, 4_000) : null,
        String(body.userAgent || request.headers.get("user-agent") || "").slice(0, 500),
        userId || null,
      ),
      this.env.DB.prepare("DELETE FROM client_errors WHERE id IN (SELECT id FROM client_errors ORDER BY created_at DESC LIMIT -1 OFFSET 500)"),
    ]);
    logMutation("client_error.record", userId, { kind: "client_error", id: "ring" }, "ok", start);
    return json({ ok: true });
  }

  private async registrationOptions(request: Request) {
    const start = Date.now();
    const body = await readJson<{ handle: string }>(request);
    const handle = cleanHandle(body.handle || "");
    assertHandle(handle);
    await cleanupBounded(this.env.DB);
    await checkRateLimit(this.env.DB, `register-options:${ipSignal(request)}:${handle}`, 12, 60_000);
    const existing = await this.env.DB.prepare("SELECT id FROM users WHERE handle = ? COLLATE NOCASE").bind(handle).first<{ id: string }>();
    if (existing) throw new HttpError("That handle is already taken.", 400);
    const userId = newId("usr");
    const { rpID } = rpInfo(request);
    const options = await generateRegistrationOptions({
      rpName: this.env.APP_NAME || "two chairs",
      rpID,
      userName: handle,
      userDisplayName: handle,
      userID: new TextEncoder().encode(userId),
      timeout: 60_000,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const now = Date.now();
    await this.env.DB.prepare(`
      INSERT INTO auth_challenges
        (id, purpose, handle, provisional_user_id, challenge, created_at, expires_at)
      VALUES (?, 'registration', ?, ?, ?, ?, ?)
      ON CONFLICT(handle) WHERE purpose = 'registration' DO UPDATE SET
        id = excluded.id,
        provisional_user_id = excluded.provisional_user_id,
        challenge = excluded.challenge,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).bind(newId("ach"), handle, userId, options.challenge, now, now + AUTH_CHALLENGE_TTL_MS).run();
    logMutation("auth.registration_options", undefined, { kind: "handle", id: handle }, "ok", start);
    return json(options);
  }

  private async registrationVerify(request: Request) {
    const start = Date.now();
    const url = new URL(request.url);
    const body = await readJson<{ handle: string; response: RegistrationResponseJSON }>(request);
    const handle = cleanHandle(body.handle || "");
    const now = Date.now();
    await cleanupBounded(this.env.DB, now);
    const pending = await this.env.DB.prepare(`
      SELECT * FROM auth_challenges
      WHERE purpose = 'registration' AND handle = ? COLLATE NOCASE AND expires_at > ?
    `).bind(handle, now).first<AuthChallengeRow>();
    if (!pending?.provisional_user_id) throw new HttpError("Registration expired. Try again.", 400);
    const { rpID, origin } = rpInfo(request);
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    if (!verification.verified || !verification.registrationInfo) throw new HttpError("Passkey registration failed.", 400);
    const credential = verification.registrationInfo.credential;
    const rawToken = newId("ses");
    const tokenHash = await sha256(rawToken);
    const userId = pending.provisional_user_id;
    const inviteToken = newId("inv");
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        INSERT INTO users (id, handle, invite_token, created_at)
        SELECT ?, ?, ?, ? FROM auth_challenges
        WHERE id = ? AND purpose = 'registration' AND expires_at > ?
      `).bind(userId, handle, inviteToken, now, pending.id, now),
      this.env.DB.prepare(`
        INSERT INTO credentials (id, user_id, public_key, counter, transports_json, created_at)
        SELECT ?, ?, ?, ?, ?, ? FROM auth_challenges
        WHERE id = ? AND purpose = 'registration' AND expires_at > ?
      `).bind(
        credential.id,
        userId,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        JSON.stringify(body.response.response.transports || []),
        now,
        pending.id,
        now,
      ),
      this.env.DB.prepare(`
        INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
        SELECT ?, ?, ?, ? FROM auth_challenges
        WHERE id = ? AND purpose = 'registration' AND expires_at > ?
      `).bind(tokenHash, userId, now, now + SESSION_TTL_MS, pending.id, now),
      this.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ? AND purpose = 'registration' AND expires_at > ?").bind(pending.id, now),
    ]);
    if (results.some((result) => changes(result) !== 1)) throw new HttpError("Registration expired. Try again.", 409);
    logMutation("auth.registration_verify", userId, { kind: "user", id: userId }, "ok", start);
    return json(
      { user: { id: userId, handle, inviteToken } },
      { headers: { "set-cookie": sessionCookie(rawToken, url) } },
    );
  }

  private async loginOptions(request: Request) {
    const start = Date.now();
    const body = await readJson<{ handle: string }>(request);
    const handle = cleanHandle(body.handle || "");
    await cleanupBounded(this.env.DB);
    await checkRateLimit(this.env.DB, `login-options:${ipSignal(request)}:${handle}`, 12, 60_000);
    const user = await this.env.DB.prepare("SELECT * FROM users WHERE handle = ? COLLATE NOCASE").bind(handle).first<UserRow>();
    if (!user) throw new HttpError("No account with that handle.", 400);
    const credentials = await this.env.DB.prepare("SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at").bind(user.id).all<CredentialRow>();
    const { rpID } = rpInfo(request);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: credentials.results.map((credential) => ({
        id: credential.id,
        transports: JSON.parse(credential.transports_json) as never,
      })),
      userVerification: "required",
      timeout: 60_000,
    });
    const now = Date.now();
    await this.env.DB.prepare(`
      INSERT INTO auth_challenges (id, purpose, user_id, challenge, created_at, expires_at)
      VALUES (?, 'authentication', ?, ?, ?, ?)
      ON CONFLICT(user_id) WHERE purpose = 'authentication' DO UPDATE SET
        id = excluded.id,
        challenge = excluded.challenge,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).bind(newId("ach"), user.id, options.challenge, now, now + AUTH_CHALLENGE_TTL_MS).run();
    logMutation("auth.login_options", user.id, { kind: "user", id: user.id }, "ok", start);
    return json(options);
  }

  private async loginVerify(request: Request) {
    const start = Date.now();
    const url = new URL(request.url);
    const body = await readJson<{ handle: string; response: AuthenticationResponseJSON }>(request);
    const handle = cleanHandle(body.handle || "");
    const now = Date.now();
    await cleanupBounded(this.env.DB, now);
    const user = await this.env.DB.prepare("SELECT * FROM users WHERE handle = ? COLLATE NOCASE").bind(handle).first<UserRow>();
    if (!user) throw new HttpError("No account with that handle.", 400);
    const pending = await this.env.DB.prepare(`
      SELECT * FROM auth_challenges
      WHERE purpose = 'authentication' AND user_id = ? AND expires_at > ?
    `).bind(user.id, now).first<AuthChallengeRow>();
    if (!pending) throw new HttpError("Login expired. Try again.", 400);
    const credential = await this.env.DB.prepare("SELECT * FROM credentials WHERE id = ? AND user_id = ?")
      .bind(body.response.id, user.id).first<CredentialRow>();
    if (!credential) throw new HttpError("Passkey not recognized.", 400);
    const { rpID, origin } = rpInfo(request);
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credential.id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.counter,
        transports: JSON.parse(credential.transports_json) as never,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new HttpError("Passkey login failed.", 400);
    const rawToken = newId("ses");
    const tokenHash = await sha256(rawToken);
    const newCounter = verification.authenticationInfo.newCounter;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE credentials SET counter = ?
        WHERE id = ? AND user_id = ? AND counter = ?
          AND EXISTS (
            SELECT 1 FROM auth_challenges
            WHERE id = ? AND purpose = 'authentication' AND user_id = ? AND expires_at > ?
          )
      `).bind(newCounter, credential.id, user.id, credential.counter, pending.id, user.id, now),
      this.env.DB.prepare(`
        INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
        SELECT ?, ?, ?, ? FROM auth_challenges a
        JOIN credentials c ON c.id = ? AND c.user_id = a.user_id AND c.counter = ?
        WHERE a.id = ? AND a.purpose = 'authentication' AND a.user_id = ? AND a.expires_at > ?
      `).bind(tokenHash, user.id, now, now + SESSION_TTL_MS, credential.id, newCounter, pending.id, user.id, now),
      this.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ? AND purpose = 'authentication' AND user_id = ? AND expires_at > ?")
        .bind(pending.id, user.id, now),
    ]);
    if (results.some((result) => changes(result) !== 1)) throw new HttpError("Login expired. Try again.", 409);
    logMutation("auth.login_verify", user.id, { kind: "user", id: user.id }, "ok", start);
    return json({ user: publicUser(user) }, { headers: { "set-cookie": sessionCookie(rawToken, url) } });
  }

  private async logout(request: Request) {
    const start = Date.now();
    const token = getCookie(request, COOKIE);
    const tokenHash = token ? await sha256(token) : "";
    const session = tokenHash
      ? await this.env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ?").bind(tokenHash).first<{ user_id: string }>()
      : null;
    const body = await readJson<{ endpoint?: string }>(request).catch(() => ({} as { endpoint?: string }));
    const statements: D1PreparedStatement[] = [];
    if (tokenHash) statements.push(this.env.DB.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?").bind(Date.now(), tokenHash));
    if (tokenHash) statements.push(this.env.DB.prepare("DELETE FROM presence_leases WHERE session_hash = ?").bind(tokenHash));
    if (session?.user_id && body.endpoint) {
      statements.push(this.env.DB.prepare("DELETE FROM pending_pushes WHERE endpoint = ? AND user_id = ?").bind(body.endpoint, session.user_id));
      statements.push(this.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(body.endpoint, session.user_id));
    }
    if (statements.length) await this.env.DB.batch(statements);
    logMutation("auth.logout", session?.user_id, { kind: "session", id: tokenHash || "(none)" }, "ok", start);
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(new URL(request.url)) } });
  }

  private async me(user: UserRow) {
    const now = Date.now();
    this.execution.waitUntil(cleanupBounded(this.env.DB, now));
    const [friends, requests, sentRequests, challenges, sentChallenges, schedules, games] = await Promise.all([
      this.env.DB.prepare(`
        SELECT u.id, u.handle,
          CASE WHEN EXISTS (
            SELECT 1 FROM presence_leases p WHERE p.user_id = u.id AND p.last_seen_at >= ?
          ) THEN 1 ELSE 0 END AS online
        FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
        WHERE f.user_a = ? OR f.user_b = ? ORDER BY u.handle
      `).bind(now - ONLINE_WINDOW_MS, user.id, user.id, user.id).all<{ id: string; handle: string; online: number }>(),
      this.env.DB.prepare(`
        SELECT r.*, u.handle AS from_handle FROM friend_requests r JOIN users u ON u.id = r.from_id
        WHERE r.to_id = ? AND r.status = 'pending' ORDER BY r.created_at
      `).bind(user.id).all<FriendRequestRow>(),
      this.env.DB.prepare(`
        SELECT r.*, u.handle AS to_handle FROM friend_requests r JOIN users u ON u.id = r.to_id
        WHERE r.from_id = ? AND r.status = 'pending' ORDER BY r.created_at
      `).bind(user.id).all<FriendRequestRow>(),
      this.env.DB.prepare(`
        SELECT c.*, u.handle AS from_handle FROM challenges c JOIN users u ON u.id = c.from_id
        WHERE c.to_id = ? AND c.status = 'pending' ORDER BY c.created_at
      `).bind(user.id).all<ChallengeRow>(),
      this.env.DB.prepare(`
        SELECT c.*, u.handle AS to_handle FROM challenges c JOIN users u ON u.id = c.to_id
        WHERE c.from_id = ? AND c.status = 'pending' ORDER BY c.created_at
      `).bind(user.id).all<ChallengeRow>(),
      this.env.DB.prepare(`
        SELECT s.*, uf.handle AS from_handle, ut.handle AS to_handle
        FROM schedules s JOIN users uf ON uf.id = s.from_id JOIN users ut ON ut.id = s.to_id
        WHERE (s.from_id = ? OR s.to_id = ?) AND s.status NOT IN ('declined', 'expired')
        ORDER BY s.created_at DESC LIMIT 250
      `).bind(user.id, user.id).all<ScheduleRow>(),
      this.env.DB.prepare(`
        SELECT * FROM games WHERE white_id = ? OR black_id = ? ORDER BY created_at DESC LIMIT 500
      `).bind(user.id, user.id).all<GameRow>(),
    ]);
    return json({
      user: publicUser(user),
      inviteUrl: `/invite/${user.invite_token}`,
      friends: friends.results.map((friend) => ({ id: friend.id, handle: friend.handle, online: friend.online === 1 })),
      requests: requests.results.map(friendRequest),
      sentRequests: sentRequests.results.map(friendRequest),
      challenges: challenges.results.map(challenge),
      sentChallenges: sentChallenges.results.map(challenge),
      schedules: schedules.results.map(schedule),
      games: games.results.map(game),
      pushPublicKey: this.env.VAPID_PUBLIC_KEY,
      pushTypes: PUSH_TYPES,
    });
  }

  private async heartbeat(request: Request, user: UserRow, tokenHash: string) {
    const body = await readJson<{ leaseId?: string; foregroundGameId?: string | null }>(request)
      .catch(() => ({} as { leaseId?: string; foregroundGameId?: string | null }));
    const suppliedLeaseId = typeof body.leaseId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.leaseId)
      ? body.leaseId
      : "";
    const leaseId = suppliedLeaseId || `legacy:${tokenHash}`;
    const leaseKey = `${user.id}:${leaseId}`;
    const foregroundGameId = typeof body.foregroundGameId === "string" && /^gam_[A-Za-z0-9_-]+$/.test(body.foregroundGameId)
      ? body.foregroundGameId
      : null;
    const now = Date.now();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        INSERT INTO presence_leases
          (lease_key, lease_id, user_id, session_hash, last_seen_at, expires_at, foreground_game_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lease_key) DO UPDATE SET
          session_hash = excluded.session_hash,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at,
          foreground_game_id = excluded.foreground_game_id
        WHERE presence_leases.user_id = excluded.user_id
      `).bind(leaseKey, leaseId, user.id, tokenHash, now, now + PRESENCE_STORAGE_TTL_MS, foregroundGameId),
      this.env.DB.prepare("DELETE FROM presence_leases WHERE lease_key IN (SELECT lease_key FROM presence_leases WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)").bind(now),
    ]);
    const usage = d1Usage(results);
    console.log(JSON.stringify({
      level: "info",
      event: "presence.heartbeat.d1_usage",
      actor: user.id,
      rows_read: usage.rowsRead,
      rows_written: usage.rowsWritten,
    }));
    return await this.me(user);
  }

  private async iceServers() {
    if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN) {
      throw new HttpError("TURN is not configured. Set TURN_KEY_ID and TURN_KEY_API_TOKEN before enabling voice calls.", 503);
    }
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 86_400 }),
    });
    if (!response.ok) throw new HttpError("Could not create voice credentials.", 503);
    const body = await response.json() as { iceServers?: RTCIceServer[] };
    const iceServers = body.iceServers || [];
    const hasTurn = iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => typeof url === "string" && (url.startsWith("turn:") || url.startsWith("turns:")));
    });
    if (!hasTurn) throw new HttpError("Voice credentials did not include TURN servers.", 503);
    return json({ iceServers });
  }

  private async subscribe(request: Request, user: UserRow) {
    const body = await readJson<{ subscription: StoredSubscription }>(request);
    const subscription = body.subscription;
    if (!subscription?.endpoint) throw new HttpError("Missing push subscription.", 400);
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM pending_pushes WHERE endpoint = ?").bind(subscription.endpoint),
      this.env.DB.prepare(`
        INSERT INTO push_subscriptions (endpoint, user_id, expiration_time, keys_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
          user_id = excluded.user_id,
          expiration_time = excluded.expiration_time,
          keys_json = excluded.keys_json,
          updated_at = excluded.updated_at
      `).bind(
        subscription.endpoint,
        user.id,
        subscription.expirationTime ?? null,
        JSON.stringify(subscription.keys || {}),
        now,
        now,
      ),
      this.env.DB.prepare(`
        DELETE FROM pending_pushes WHERE endpoint IN (
          SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET 5
        )
      `).bind(user.id),
      this.env.DB.prepare(`
        DELETE FROM push_subscriptions WHERE endpoint IN (
          SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET 5
        )
      `).bind(user.id),
    ]);
    return json({ ok: true, pushTypes: PUSH_TYPES });
  }

  private async unsubscribe(request: Request, user: UserRow) {
    const body = await readJson<{ endpoint?: string }>(request).catch(() => ({} as { endpoint?: string }));
    if (body.endpoint) {
      await this.env.DB.batch([
        this.env.DB.prepare("DELETE FROM pending_pushes WHERE endpoint = ? AND user_id = ?").bind(body.endpoint, user.id),
        this.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(body.endpoint, user.id),
      ]);
    } else {
      await this.env.DB.batch([
        this.env.DB.prepare("DELETE FROM pending_pushes WHERE user_id = ? AND endpoint <> ''").bind(user.id),
        this.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").bind(user.id),
      ]);
    }
    return json({ ok: true });
  }

  private async readPendingPush(request: Request, user: UserRow) {
    const body = await readJson<{ endpoint?: string; ackId?: string }>(request)
      .catch(() => ({} as { endpoint?: string; ackId?: string }));
    const endpoint = body.endpoint || "";
    if (body.ackId) {
      await this.env.DB.prepare(`
        DELETE FROM pending_pushes
        WHERE id = ? AND user_id = ? AND (
          endpoint = '' OR endpoint = ? AND EXISTS (
            SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?
          )
        )
      `).bind(body.ackId, user.id, endpoint, endpoint, user.id).run();
      return json({ ok: true });
    }
    if (endpoint) {
      const owned = await this.env.DB.prepare("SELECT 1 AS owned FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
        .bind(endpoint, user.id).first<{ owned: number }>();
      if (!owned) return json(null);
    }
    const row = await this.env.DB.prepare(`
      DELETE FROM pending_pushes
      WHERE id = (
        SELECT id FROM pending_pushes
        WHERE user_id = ? AND endpoint = ? AND expires_at > ?
        ORDER BY created_at LIMIT 1
      )
      RETURNING *
    `).bind(user.id, endpoint, Date.now()).first<PendingPushRow>();
    return json(row ? pendingPush(row) : null);
  }

  private async requestFriend(request: Request, user: UserRow) {
    const body = await readJson<{ handle: string }>(request);
    const targetHandle = cleanHandle(body.handle || "");
    const target = await this.env.DB.prepare("SELECT * FROM users WHERE handle = ? COLLATE NOCASE").bind(targetHandle).first<UserRow>();
    if (!target) throw new HttpError("No account with that handle.", 400);
    if (target.id === user.id) throw new HttpError("Use a friend's handle.", 400);
    const [pairA, pairB] = pair(user.id, target.id);
    const friendship = await this.env.DB.prepare("SELECT id FROM friendships WHERE user_a = ? AND user_b = ?")
      .bind(pairA, pairB).first<{ id: string }>();
    if (friendship) throw new HttpError("You are already friends.", 400);
    const duplicate = await this.env.DB.prepare("SELECT * FROM friend_requests WHERE pair_a = ? AND pair_b = ? AND status = 'pending'")
      .bind(pairA, pairB).first<FriendRequestRow>();
    if (duplicate) return json({ request: friendRequest(duplicate) });
    const id = newId("frq");
    const now = Date.now();
    const eventKey = `friend_request:${id}`;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        INSERT OR IGNORE INTO friend_requests
          (id, from_id, to_id, pair_a, pair_b, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?
        )
      `).bind(id, user.id, target.id, pairA, pairB, now, now, pairA, pairB),
      ...enqueuePushStatements(
        this.env.DB,
        eventKey,
        target.id,
        "friend_request",
        `@${user.handle} sent a friend request`,
        "/",
        "SELECT 1 FROM friend_requests WHERE id = ? AND status = 'pending'",
        [id],
        now,
      ),
    ]);
    if (changes(results[0]) !== 1) {
      const existing = await this.env.DB.prepare("SELECT * FROM friend_requests WHERE pair_a = ? AND pair_b = ? AND status = 'pending'")
        .bind(pairA, pairB).first<FriendRequestRow>();
      if (existing) return json({ request: friendRequest(existing) });
      throw new HttpError("Friend request not available.", 409);
    }
    this.execution.waitUntil(deliverPushEvent(this.env, eventKey));
    return json({ request: friendRequest({ id, from_id: user.id, to_id: target.id, status: "pending", created_at: now }) });
  }

  private async requestByInvite(request: Request, user: UserRow) {
    const body = await readJson<{ token: string }>(request);
    const target = await this.env.DB.prepare("SELECT * FROM users WHERE invite_token = ?").bind(body.token).first<UserRow>();
    if (!target) throw new HttpError("Invite link not found.", 400);
    if (target.id === user.id) throw new HttpError("That's your own invite link.", 400);
    const [userA, userB] = pair(user.id, target.id);
    const existing = await this.env.DB.prepare("SELECT id FROM friendships WHERE user_a = ? AND user_b = ?")
      .bind(userA, userB).first<{ id: string }>();
    if (existing) return json({ status: "already-friends", friend: { id: target.id, handle: target.handle } });
    const pending = await this.env.DB.prepare("SELECT id FROM friend_requests WHERE pair_a = ? AND pair_b = ? AND status = 'pending'")
      .bind(userA, userB).first<{ id: string }>();
    const now = Date.now();
    const results = await this.env.DB.batch([
      this.env.DB.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE pair_a = ? AND pair_b = ? AND status = 'pending'")
        .bind(now, userA, userB),
      this.env.DB.prepare("INSERT OR IGNORE INTO friendships (id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)")
        .bind(friendshipId(userA, userB), userA, userB, now),
    ]);
    return json({ status: pending || changes(results[0]) ? "accepted" : "created", friend: { id: target.id, handle: target.handle } });
  }

  private async acceptFriend(id: string, user: UserRow) {
    const request = await this.env.DB.prepare("SELECT * FROM friend_requests WHERE id = ?").bind(id).first<FriendRequestRow>();
    if (!request || request.to_id !== user.id) throw new HttpError("Friend request not available.", 400);
    const [userA, userB] = pair(request.from_id, request.to_id);
    if (request.status === "pending") {
      const now = Date.now();
      const results = await this.env.DB.batch([
        this.env.DB.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE id = ? AND to_id = ? AND status = 'pending'")
          .bind(now, id, user.id),
        this.env.DB.prepare(`
          INSERT OR IGNORE INTO friendships (id, user_a, user_b, created_at)
          SELECT ?, ?, ?, ? FROM friend_requests WHERE id = ? AND status = 'accepted'
        `).bind(friendshipId(userA, userB), userA, userB, now, id),
      ]);
      if (changes(results[0]) !== 1) {
        const current = await this.env.DB.prepare("SELECT status FROM friend_requests WHERE id = ?").bind(id).first<{ status: FriendRequestRow["status"] }>();
        if (current?.status !== "accepted") throw new HttpError("Friend request not available.", 409);
      }
    } else if (request.status !== "accepted") {
      throw new HttpError("Friend request not available.", 400);
    }
    const refreshed = await this.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>();
    return await this.me(refreshed!);
  }

  private async declineFriendRequest(id: string, user: UserRow) {
    const request = await this.env.DB.prepare("SELECT * FROM friend_requests WHERE id = ?").bind(id).first<FriendRequestRow>();
    if (!request) return json({ status: "gone" });
    if (request.to_id !== user.id) throw new HttpError("Only the recipient can decline.", 403);
    if (request.status === "pending") {
      const results = await this.env.DB.batch([
        this.env.DB.prepare("UPDATE friend_requests SET status = 'declined', updated_at = ? WHERE id = ? AND to_id = ? AND status = 'pending'")
          .bind(Date.now(), id, user.id),
        this.env.DB.prepare("DELETE FROM pending_pushes WHERE event_key = ? AND user_id = ?").bind(`friend_request:${id}`, user.id),
      ]);
      if (changes(results[0]) === 1) return json({ status: "declined" });
      const current = await this.env.DB.prepare("SELECT status FROM friend_requests WHERE id = ?").bind(id).first<{ status: FriendRequestRow["status"] }>();
      return json({ status: current?.status || "gone" });
    }
    return json({ status: request.status });
  }

  private async withdrawFriendRequest(id: string, user: UserRow) {
    const request = await this.env.DB.prepare("SELECT * FROM friend_requests WHERE id = ?").bind(id).first<FriendRequestRow>();
    if (!request) return json({ status: "gone" });
    if (request.from_id !== user.id) throw new HttpError("Only the sender can withdraw.", 403);
    if (request.status !== "pending") return json({ status: request.status });
    const results = await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM pending_pushes WHERE event_key = ? AND user_id = ?").bind(`friend_request:${id}`, request.to_id),
      this.env.DB.prepare("DELETE FROM friend_requests WHERE id = ? AND from_id = ? AND status = 'pending'").bind(id, user.id),
    ]);
    if (changes(results[1]) === 1) return json({ status: "withdrawn" });
    const current = await this.env.DB.prepare("SELECT status FROM friend_requests WHERE id = ?").bind(id).first<{ status: FriendRequestRow["status"] }>();
    return json({ status: current?.status || "gone" });
  }

  private async createChallenge(request: Request, user: UserRow) {
    const body = await readJson<{ friendId: string; timeControl?: TimeControl }>(request);
    const target = await this.requireFriend(user.id, body.friendId);
    const [pairA, pairB] = pair(user.id, target.id);
    const duplicate = await this.env.DB.prepare("SELECT * FROM challenges WHERE pair_a = ? AND pair_b = ? AND status = 'pending'")
      .bind(pairA, pairB).first<ChallengeRow>();
    if (duplicate) {
      if (duplicate.from_id === user.id) return json({ challenge: challenge(duplicate) });
      throw new HttpError(`@${target.handle} already invited you — accept theirs instead.`, 409);
    }
    const id = newId("chl");
    const now = Date.now();
    const timeControl = validTimeControl(body.timeControl);
    const eventKey = `challenge:${id}`;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        INSERT OR IGNORE INTO challenges
          (id, from_id, to_id, pair_a, pair_b, time_control, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).bind(id, user.id, target.id, pairA, pairB, timeControl, now, now),
      ...enqueuePushStatements(
        this.env.DB,
        eventKey,
        target.id,
        "challenge",
        `@${user.handle} invited you to a game`,
        "/",
        "SELECT 1 FROM challenges WHERE id = ? AND status = 'pending'",
        [id],
        now,
      ),
    ]);
    if (changes(results[0]) !== 1) {
      const existing = await this.env.DB.prepare("SELECT * FROM challenges WHERE pair_a = ? AND pair_b = ? AND status = 'pending'")
        .bind(pairA, pairB).first<ChallengeRow>();
      if (existing?.from_id === user.id) return json({ challenge: challenge(existing) });
      if (existing) throw new HttpError(`@${target.handle} already invited you — accept theirs instead.`, 409);
      throw new HttpError("Challenge not available.", 409);
    }
    this.execution.waitUntil(deliverPushEvent(this.env, eventKey));
    return json({ challenge: challenge({
      id,
      from_id: user.id,
      to_id: target.id,
      time_control: timeControl,
      status: "pending",
      game_id: null,
      created_at: now,
    }) });
  }

  private async withdrawChallenge(id: string, user: UserRow) {
    const row = await this.env.DB.prepare("SELECT * FROM challenges WHERE id = ?").bind(id).first<ChallengeRow>();
    if (!row) return json({ status: "gone" });
    if (row.from_id !== user.id) throw new HttpError("Only the inviter can withdraw.", 403);
    if (row.status === "pending") {
      const results = await this.env.DB.batch([
        this.env.DB.prepare("UPDATE challenges SET status = 'withdrawn', updated_at = ? WHERE id = ? AND from_id = ? AND status = 'pending'")
          .bind(Date.now(), id, user.id),
        this.env.DB.prepare("DELETE FROM pending_pushes WHERE event_key = ? AND user_id = ?").bind(`challenge:${id}`, row.to_id),
      ]);
      if (changes(results[0]) === 1) return json({ status: "withdrawn" });
      const current = await this.env.DB.prepare("SELECT status FROM challenges WHERE id = ?").bind(id).first<{ status: ChallengeRow["status"] }>();
      return json({ status: current?.status || "gone" });
    }
    return json({ status: row.status });
  }

  private async declineChallenge(id: string, user: UserRow) {
    const row = await this.env.DB.prepare("SELECT * FROM challenges WHERE id = ?").bind(id).first<ChallengeRow>();
    if (!row) return json({ status: "gone" });
    if (row.to_id !== user.id) throw new HttpError("Only the invitee can decline.", 403);
    if (row.status === "pending") {
      const results = await this.env.DB.batch([
        this.env.DB.prepare("UPDATE challenges SET status = 'declined', updated_at = ? WHERE id = ? AND to_id = ? AND status = 'pending'")
          .bind(Date.now(), id, user.id),
        this.env.DB.prepare("DELETE FROM pending_pushes WHERE event_key = ? AND user_id = ?").bind(`challenge:${id}`, user.id),
      ]);
      if (changes(results[0]) === 1) return json({ status: "declined" });
      const current = await this.env.DB.prepare("SELECT status FROM challenges WHERE id = ?").bind(id).first<{ status: ChallengeRow["status"] }>();
      return json({ status: current?.status || "gone" });
    }
    return json({ status: row.status });
  }

  private async acceptChallenge(id: string, user: UserRow) {
    let row = await this.env.DB.prepare("SELECT * FROM challenges WHERE id = ?").bind(id).first<ChallengeRow>();
    if (!row || row.to_id !== user.id) throw new HttpError("Challenge not available.", 400);
    if (row.status !== "pending" && row.status !== "accepted") throw new HttpError("Challenge not available.", 400);
    if (row.status === "pending") {
      const gameId = newId("gam");
      const now = Date.now();
      const eventKey = `challenge_accepted:${id}`;
      await this.env.DB.batch([
        this.env.DB.prepare(`
          UPDATE challenges SET status = 'accepted', game_id = ?, updated_at = ?
          WHERE id = ? AND to_id = ? AND status = 'pending'
        `).bind(gameId, now, id, user.id),
        this.env.DB.prepare(`
          INSERT OR IGNORE INTO games
            (id, white_id, black_id, time_control, source, status, created_at, projection_updated_at)
          SELECT game_id, from_id, to_id, time_control, 'challenge', 'active', ?, ?
          FROM challenges WHERE id = ? AND game_id = ? AND status = 'accepted'
        `).bind(now, now, id, gameId),
        ...enqueuePushStatements(
          this.env.DB,
          eventKey,
          row.from_id,
          "challenge_accepted",
          `@${user.handle} accepted — your game is ready`,
          `/game/${gameId}`,
          "SELECT 1 FROM challenges WHERE id = ? AND game_id = ? AND status = 'accepted'",
          [id, gameId],
          now,
        ),
      ]);
      row = await this.env.DB.prepare("SELECT * FROM challenges WHERE id = ?").bind(id).first<ChallengeRow>();
      if (!row?.game_id || row.status !== "accepted") throw new HttpError("Challenge was already resolved.", 409);
      this.execution.waitUntil(deliverPushEvent(this.env, `challenge_accepted:${id}`));
    }
    const gameRow = await this.env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(row.game_id).first<GameRow>();
    if (!gameRow) throw new HttpError("Accepted challenge has no game.", 500);
    await ensureD1GameInitialized(this.env, gameRow);
    return json({ game: game(gameRow) });
  }

  private async challengeState(id: string, user: UserRow) {
    const row = await this.env.DB.prepare(`
      SELECT c.*, uf.handle AS from_handle, ut.handle AS to_handle
      FROM challenges c JOIN users uf ON uf.id = c.from_id JOIN users ut ON ut.id = c.to_id
      WHERE c.id = ? AND (c.from_id = ? OR c.to_id = ?)
    `).bind(id, user.id, user.id).first<ChallengeRow>();
    if (!row) throw new HttpError("Challenge not available.", 404);
    return json({ challenge: challenge(row) });
  }

  private async requireFriend(userId: string, friendId: string) {
    const target = await this.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(friendId).first<UserRow>();
    if (!target) throw new HttpError("Friend not found.", 404);
    const [userA, userB] = pair(userId, friendId);
    const friendship = await this.env.DB.prepare("SELECT id FROM friendships WHERE user_a = ? AND user_b = ?")
      .bind(userA, userB).first<{ id: string }>();
    if (!friendship) throw new HttpError("You can only play friends.", 403);
    return target;
  }

  private async createSchedule(request: Request, user: UserRow) {
    const body = await readJson<{ friendId: string; startAt: number; timeControl?: TimeControl; recurrence?: Recurrence }>(request);
    const target = await this.requireFriend(user.id, body.friendId);
    const startAt = Number(body.startAt);
    if (!Number.isFinite(startAt) || startAt < Date.now() - 60_000) throw new HttpError("Choose a future time.", 400);
    const recurrence = validateRecurrence(body.recurrence);
    const candidate = startAt + SCHEDULE_PENDING_GRACE_MS;
    const handoffId = newId("wake");
    await tellScheduler(this.env, "/wake-no-later", { candidate, handoffId });
    const id = newId("sch");
    const opId = clientOpId(request);
    const requestKey = opId ? `${user.id}:${opId}` : id;
    const now = Date.now();
    const result = await this.env.DB.prepare(`
      INSERT OR IGNORE INTO schedules
        (id, request_key, from_id, to_id, time_control, start_at, next_fire_at, recurrence_kind,
         recurrence_weekday, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).bind(
      id,
      requestKey,
      user.id,
      target.id,
      validTimeControl(body.timeControl),
      startAt,
      startAt,
      recurrence.kind,
      recurrence.kind === "weekly" ? recurrence.weekday : null,
      now,
      now,
    ).run();
    await tellScheduler(this.env, "/canonicalize", { handoffId });
    const row = changes(result) === 1
      ? await this.env.DB.prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first<ScheduleRow>()
      : await this.env.DB.prepare("SELECT * FROM schedules WHERE request_key = ?").bind(requestKey).first<ScheduleRow>();
    if (!row) throw new HttpError("Could not create schedule.", 409);
    return json({ schedule: schedule(row) });
  }

  private async acceptSchedule(id: string, user: UserRow) {
    let row = await this.env.DB.prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first<ScheduleRow>();
    if (!row || row.to_id !== user.id) throw new HttpError("Schedule not available.", 400);
    if (row.status === "pending") {
      const handoffId = newId("wake");
      await tellScheduler(this.env, "/wake-no-later", { candidate: row.next_fire_at, handoffId });
      await this.env.DB.prepare(`
        UPDATE schedules SET status = 'accepted', updated_at = ?
        WHERE id = ? AND to_id = ? AND status = 'pending'
      `).bind(Date.now(), id, user.id).run();
      await tellScheduler(this.env, "/canonicalize", { handoffId });
      row = await this.env.DB.prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first<ScheduleRow>();
    }
    if (!row || (row.status !== "accepted" && row.status !== "fired")) throw new HttpError("Schedule not available.", 400);
    return json({ schedule: schedule(row) });
  }

  private async declineSchedule(id: string, user: UserRow) {
    const row = await this.env.DB.prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first<ScheduleRow>();
    if (!row) return json({ status: "gone" });
    if (row.to_id !== user.id) throw new HttpError("Only the recipient can decline.", 403);
    if (row.status === "pending") {
      const result = await this.env.DB.prepare("UPDATE schedules SET status = 'declined', updated_at = ? WHERE id = ? AND to_id = ? AND status = 'pending'")
        .bind(Date.now(), id, user.id).run();
      await tellScheduler(this.env, "/canonicalize");
      if (changes(result) === 1) return json({ status: "declined" });
      const current = await this.env.DB.prepare("SELECT status FROM schedules WHERE id = ?").bind(id).first<{ status: ScheduleRow["status"] }>();
      return json({ status: current?.status || "gone" });
    }
    return json({ status: row.status });
  }

  private async cancelSchedule(id: string, user: UserRow) {
    let row = await this.env.DB.prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first<ScheduleRow>();
    if (!row) throw new HttpError("Schedule not found.", 404);
    if (row.from_id !== user.id && row.to_id !== user.id) throw new HttpError("Not your schedule.", 403);
    if (row.status === "pending" || row.status === "accepted") {
      await this.env.DB.prepare(`
        UPDATE schedules SET status = 'cancelled', cancelled_by = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'accepted')
      `).bind(user.id, Date.now(), id).run();
      await tellScheduler(this.env, "/canonicalize");
      row = await this.env.DB.prepare("SELECT * FROM schedules WHERE id = ?").bind(id).first<ScheduleRow>();
    }
    return json({ schedule: schedule(row!) });
  }

  private assertDebug(request: Request) {
    if (request.headers.get("x-debug-local") !== "true") throw new HttpError("Debug endpoint is local only.", 404);
  }

  private async debugPushLog(request: Request) {
    this.assertDebug(request);
    const logs = await this.env.DB.prepare(`
      SELECT type, user_id, created_at, delivered, status
      FROM push_delivery_logs ORDER BY created_at DESC LIMIT 50
    `).all<{ type: PushType; user_id: string; created_at: number; delivered: number; status: number | null }>();
    const pending = await this.env.DB.prepare("SELECT * FROM pending_pushes WHERE endpoint = '' ORDER BY created_at LIMIT 250").all<PendingPushRow>();
    const pendingPushes = pending.results.map(pendingPush).reduce<Record<string, ReturnType<typeof pendingPush>[]>>((queues, entry) => {
      (queues[entry.userId] ||= []).push(entry);
      return queues;
    }, {});
    return json({
      pushTypes: PUSH_TYPES,
      pushLog: logs.results.reverse().map((entry) => ({
        type: entry.type,
        userId: entry.user_id,
        createdAt: entry.created_at,
        delivered: entry.delivered === 1,
        ...(entry.status === null ? {} : { status: entry.status }),
      })),
      pendingPushes,
    });
  }

  private async debugClientErrors(request: Request) {
    this.assertDebug(request);
    const rows = await this.env.DB.prepare(`
      SELECT id, created_at, url, message, stack, user_agent, user_id
      FROM client_errors ORDER BY created_at DESC LIMIT 500
    `).all<{ id: string; created_at: number; url: string; message: string; stack: string | null; user_agent: string; user_id: string | null }>();
    return json({
      clientErrors: rows.results.reverse().map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        url: row.url,
        message: row.message,
        ...(row.stack ? { stack: row.stack } : {}),
        userAgent: row.user_agent,
        ...(row.user_id ? { userId: row.user_id } : {}),
      })),
    });
  }

  private async debugDbStats(request: Request) {
    this.assertDebug(request);
    const tables = [
      "users",
      "credentials",
      "sessions",
      "auth_challenges",
      "friend_requests",
      "friendships",
      "challenges",
      "schedules",
      "schedule_occurrences",
      "games",
      "presence_leases",
      "push_subscriptions",
      "pending_pushes",
      "push_delivery_logs",
      "idempotency_results",
      "rate_limits",
      "client_errors",
    ] as const;
    const values = await Promise.all(tables.map(async (table) => {
      const row = await this.env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
      return [table, Number(row?.count || 0)] as const;
    }));
    const counts = Object.fromEntries(values) as Record<string, number>;
    counts.pushLog = counts.push_delivery_logs;
    counts.pendingPushesByEndpoint = Number((await this.env.DB.prepare("SELECT COUNT(DISTINCT endpoint) AS count FROM pending_pushes WHERE endpoint <> ''").first<{ count: number }>())?.count || 0);
    return json({ storage: "d1", counts });
  }

  private async debugReset(request: Request) {
    this.assertDebug(request);
    const tables = [
      "schedule_occurrences",
      "pending_pushes",
      "push_delivery_logs",
      "presence_leases",
      "idempotency_results",
      "rate_limits",
      "client_errors",
      "push_subscriptions",
      "challenges",
      "friend_requests",
      "friendships",
      "schedules",
      "games",
      "sessions",
      "auth_challenges",
      "credentials",
      "users",
    ];
    await this.env.DB.batch(tables.map((table) => this.env.DB.prepare(`DELETE FROM ${table}`)));
    await tellScheduler(this.env, "/reset");
    return json({ ok: true });
  }

  private async debugTick(request: Request) {
    this.assertDebug(request);
    const body = await readJson<{ now?: number; scheduleId?: string }>(request)
      .catch(() => ({} as { now?: number; scheduleId?: string }));
    const target = typeof body.now === "number" ? body.now : Date.now();
    const scheduleId = typeof body.scheduleId === "string" ? body.scheduleId : null;
    const now = Date.now();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE schedules SET start_at = ?, updated_at = ?
        WHERE status = 'pending' AND start_at <= ? AND (? IS NULL OR id = ?)
      `).bind(now - SCHEDULE_PENDING_GRACE_MS - 1_000, now, target, scheduleId, scheduleId),
      this.env.DB.prepare(`
        UPDATE schedules SET next_fire_at = ?, updated_at = ?
        WHERE status = 'accepted' AND next_fire_at <= ? AND (? IS NULL OR id = ?)
      `).bind(now - 1, now, target, scheduleId, scheduleId),
    ]);
    await tellScheduler(this.env, "/debug-run");
    return json({ tick: target, moved: changes(results[0]) + changes(results[1]) });
  }
}

function enqueuePushStatements(
  db: D1Database,
  eventKey: string,
  userId: string,
  type: PushType,
  body: string,
  url: string,
  guardSql: string,
  guardBindings: unknown[],
  now: number,
) {
  if (!PUSH_TYPES.includes(type)) throw new HttpError("Push type is not allowed.", 400);
  const values = [eventKey, userId, type, body, url, now, now + PENDING_PUSH_TTL_MS, now];
  return [
    db.prepare(`
      INSERT OR IGNORE INTO pending_pushes
        (id, event_key, user_id, endpoint, type, body, url, created_at, expires_at, next_attempt_at)
      SELECT 'psh_' || lower(hex(randomblob(12))), ?, ?, p.endpoint, ?, ?, ?, ?, ?, ?
      FROM push_subscriptions p
      WHERE p.user_id = ? AND EXISTS (${guardSql})
    `).bind(...values, userId, ...guardBindings),
    db.prepare(`
      INSERT OR IGNORE INTO pending_pushes
        (id, event_key, user_id, endpoint, type, body, url, created_at, expires_at, next_attempt_at)
      SELECT 'psh_' || lower(hex(randomblob(12))), ?, ?, '', ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = ?)
        AND EXISTS (${guardSql})
    `).bind(...values, userId, ...guardBindings),
  ];
}

async function enqueuePushEvent(
  env: D1AppEnv,
  eventKey: string,
  userId: string,
  type: PushType,
  body: string,
  url: string,
  guardSql: string,
  guardBindings: unknown[],
) {
  const now = Date.now();
  await env.DB.batch(enqueuePushStatements(env.DB, eventKey, userId, type, body, url, guardSql, guardBindings, now));
}

async function signVapidJwt(audience: string, subject: string, privateJwk: JsonWebKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = isoBase64URL.fromBuffer(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = isoBase64URL.fromBuffer(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 12 * 60 * 60, sub: subject })));
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

async function sendWebPush(subscription: StoredSubscription, env: D1AppEnv) {
  try {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { delivered: false, error: "VAPID is not configured" };
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
  } catch (error) {
    return { delivered: false, error: error instanceof Error ? error.message : "Push failed" };
  }
}

export async function deliverPushEvent(env: D1AppEnv, eventKey: string) {
  const now = Date.now();
  const rows = await env.DB.prepare(`
    SELECT p.*, s.keys_json, s.expiration_time
    FROM pending_pushes p JOIN push_subscriptions s ON s.endpoint = p.endpoint AND s.user_id = p.user_id
    WHERE p.event_key = ? AND p.endpoint <> '' AND p.expires_at > ? AND p.next_attempt_at <= ?
    ORDER BY p.created_at LIMIT 20
  `).bind(eventKey, now, now).all<PendingPushRow>();
  if (rows.results.length === 0) {
    const fallback = await env.DB.prepare("SELECT * FROM pending_pushes WHERE event_key = ? AND endpoint = '' AND expires_at > ? LIMIT 1")
      .bind(eventKey, now).first<PendingPushRow>();
    if (fallback) {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO push_delivery_logs (id, event_key, user_id, endpoint, type, delivered, created_at)
          VALUES (?, ?, ?, '', ?, 0, ?)
        `).bind(newId("pdl"), eventKey, fallback.user_id, fallback.type, now),
        env.DB.prepare("DELETE FROM push_delivery_logs WHERE id IN (SELECT id FROM push_delivery_logs ORDER BY created_at DESC LIMIT -1 OFFSET 50)"),
      ]);
    }
    return;
  }
  for (const row of rows.results) {
    const result = await sendWebPush({
      endpoint: row.endpoint,
      expirationTime: row.expiration_time,
      keys: JSON.parse(row.keys_json || "{}") as Record<string, string>,
    }, env);
    const retryAt = now + Math.min(60_000, 2_000 * 2 ** Math.min(row.delivery_attempts, 5));
    const statements = [
      env.DB.prepare(`
        INSERT INTO push_delivery_logs (id, event_key, user_id, endpoint, type, delivered, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(newId("pdl"), eventKey, row.user_id, row.endpoint, row.type, result.delivered ? 1 : 0, result.status ?? null, Date.now()),
      env.DB.prepare("DELETE FROM push_delivery_logs WHERE id IN (SELECT id FROM push_delivery_logs ORDER BY created_at DESC LIMIT -1 OFFSET 50)"),
    ];
    if (result.status === 404 || result.status === 410) {
      statements.push(env.DB.prepare("DELETE FROM pending_pushes WHERE endpoint = ?").bind(row.endpoint));
      statements.push(env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(row.endpoint, row.user_id));
    } else {
      statements.push(env.DB.prepare(`
        UPDATE pending_pushes SET
          delivery_attempts = delivery_attempts + 1,
          next_attempt_at = ?,
          last_status = ?,
          last_error = ?
        WHERE id = ?
      `).bind(retryAt, result.status ?? null, result.error ?? null, row.id));
    }
    await env.DB.batch(statements);
  }
}

export async function ensureD1GameInitialized(env: D1AppEnv, row: GameRow) {
  if (row.initialized_at) return;
  const players = await env.DB.prepare(`
    SELECT
      (SELECT handle FROM users WHERE id = ?) AS white_handle,
      (SELECT handle FROM users WHERE id = ?) AS black_handle
  `).bind(row.white_id, row.black_id).first<{ white_handle: string | null; black_handle: string | null }>();
  if (!players?.white_handle || !players.black_handle) throw new HttpError("Cannot initialize game without both players.", 500);
  const stub = env.GAME_DO.get(env.GAME_DO.idFromName(row.id));
  const response = await stub.fetch("https://game.local/init", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal": "d1" },
    body: JSON.stringify({
      id: row.id,
      whiteId: row.white_id,
      blackId: row.black_id,
      whiteHandle: players.white_handle,
      blackHandle: players.black_handle,
      timeControl: row.time_control,
    }),
  });
  if (!response.ok) {
    const message = `Game initialization failed (${response.status}).`;
    await env.DB.prepare(`
      UPDATE games SET init_attempts = init_attempts + 1, init_retry_at = ?, init_error = ?
      WHERE id = ? AND initialized_at IS NULL
    `).bind(Date.now() + 2_000, message, row.id).run();
    throw new HttpError(message, 503);
  }
  await env.DB.prepare(`
    UPDATE games SET initialized_at = COALESCE(initialized_at, ?), init_retry_at = NULL, init_error = NULL
    WHERE id = ?
  `).bind(Date.now(), row.id).run();
}

export async function projectGameStatus(env: D1AppEnv, projection: { id: string; status: GameStatus; result?: string; updatedAt: number }) {
  const terminal = projection.status !== "active";
  if (!terminal) return;
  await env.DB.prepare(`
    UPDATE games SET status = ?, result = ?, projection_updated_at = ?
    WHERE id = ? AND projection_updated_at <= ? AND (status = 'active' OR status = ?)
  `).bind(projection.status, projection.result || null, projection.updatedAt, projection.id, projection.updatedAt, projection.status).run();
}

export async function enqueueCallInvitePush(
  env: D1AppEnv,
  input: { gameId: string; callSessionId: string; initiatorId: string; recipientId: string },
) {
  const row = await env.DB.prepare(`
    SELECT g.*, u.handle AS initiator_handle
    FROM games g JOIN users u ON u.id = ?
    WHERE g.id = ? AND ? IN (g.white_id, g.black_id) AND ? IN (g.white_id, g.black_id)
  `).bind(input.initiatorId, input.gameId, input.initiatorId, input.recipientId)
    .first<GameRow & { initiator_handle: string }>();
  if (!row) throw new HttpError("Call invite not available.", 404);
  const leases = await env.DB.prepare(`
    SELECT foreground_game_id FROM presence_leases
    WHERE user_id = ? AND last_seen_at >= ?
  `).bind(input.recipientId, Date.now() - FOREGROUND_WINDOW_MS).all<{ foreground_game_id: string | null }>()
    .catch(() => ({ results: [] as Array<{ foreground_game_id: string | null }> }));
  const unambiguousForeground = leases.results.length > 0
    && leases.results.every((lease) => lease.foreground_game_id === input.gameId);
  if (unambiguousForeground) return { pushed: false };
  const eventKey = `call_invite:${input.callSessionId}:${input.recipientId}`;
  await enqueuePushEvent(
    env,
    eventKey,
    input.recipientId,
    "call_invite",
    `@${row.initiator_handle} wants to talk`,
    `/game/${input.gameId}`,
    "SELECT 1 FROM games WHERE id = ?",
    [input.gameId],
  );
  await deliverPushEvent(env, eventKey);
  return { pushed: true };
}

function advanceScheduledTime(scheduledFor: number, recurrence: ScheduleRow["recurrence_kind"], now: number) {
  const interval = recurrence === "weekly" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  let next = scheduledFor + interval;
  while (next <= now) next += interval;
  return next;
}

async function stableGameId(scheduleId: string, scheduledFor: number) {
  const digest = await sha256(`${scheduleId}:${scheduledFor}`);
  return `gam_${digest.slice(0, 16)}`;
}

async function canonicalSchedulerDeadline(db: D1Database) {
  const row = await db.prepare(`
    SELECT MIN(deadline) AS deadline FROM (
      SELECT next_fire_at AS deadline FROM schedules WHERE status = 'accepted'
      UNION ALL
      SELECT start_at + ? AS deadline FROM schedules WHERE status = 'pending'
      UNION ALL
      SELECT retry_at AS deadline FROM schedule_occurrences WHERE effects_completed_at IS NULL
      UNION ALL
      SELECT next_attempt_at AS deadline FROM pending_pushes
        WHERE event_key LIKE 'schedule:%' AND endpoint <> '' AND expires_at > ?
    )
  `).bind(SCHEDULE_PENDING_GRACE_MS, Date.now()).first<{ deadline: number | null }>();
  return row?.deadline ?? null;
}

async function claimDueScheduleOccurrences(env: D1AppEnv, now: number) {
  const due = await env.DB.prepare(`
    SELECT * FROM schedules WHERE status = 'accepted' AND next_fire_at <= ?
    ORDER BY next_fire_at LIMIT ?
  `).bind(now, SCHEDULER_BATCH_SIZE).all<ScheduleRow>();
  if (!due.results.length) return;
  const statements: D1PreparedStatement[] = [];
  for (const row of due.results) {
    const scheduledFor = row.next_fire_at;
    const gameId = await stableGameId(row.id, scheduledFor);
    const occurrenceKey = `${row.id}:${scheduledFor}`;
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO games
        (id, white_id, black_id, time_control, source, status, created_at, projection_updated_at)
      SELECT ?, from_id, to_id, time_control, 'schedule', 'active', ?, ?
      FROM schedules WHERE id = ? AND status = 'accepted' AND next_fire_at = ?
    `).bind(gameId, now, now, row.id, scheduledFor));
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO schedule_occurrences
        (occurrence_key, schedule_id, scheduled_for, game_id, claimed_at, retry_at)
      SELECT ?, ?, ?, ?, ?, ? FROM schedules
      WHERE id = ? AND status = 'accepted' AND next_fire_at = ?
    `).bind(occurrenceKey, row.id, scheduledFor, gameId, now, now, row.id, scheduledFor));
    if (row.recurrence_kind === "once") {
      statements.push(env.DB.prepare(`
        UPDATE schedules SET status = 'fired', game_id = COALESCE(game_id, ?), last_game_id = ?, updated_at = ?
        WHERE id = ? AND status = 'accepted' AND next_fire_at = ?
      `).bind(gameId, gameId, now, row.id, scheduledFor));
    } else {
      statements.push(env.DB.prepare(`
        UPDATE schedules SET next_fire_at = ?, game_id = COALESCE(game_id, ?), last_game_id = ?, updated_at = ?
        WHERE id = ? AND status = 'accepted' AND next_fire_at = ?
      `).bind(advanceScheduledTime(scheduledFor, row.recurrence_kind, now), gameId, gameId, now, row.id, scheduledFor));
    }
  }
  await env.DB.batch(statements);
}

async function unfinishedScheduleOccurrences(env: D1AppEnv, now: number) {
  return await env.DB.prepare(`
    SELECT o.*, s.from_id, s.to_id, s.time_control,
      uf.handle AS from_handle, ut.handle AS to_handle
    FROM schedule_occurrences o
    JOIN schedules s ON s.id = o.schedule_id
    JOIN users uf ON uf.id = s.from_id
    JOIN users ut ON ut.id = s.to_id
    WHERE o.effects_completed_at IS NULL AND o.retry_at <= ?
    ORDER BY o.retry_at, o.claimed_at LIMIT ?
  `).bind(now, SCHEDULER_BATCH_SIZE).all<ScheduleOccurrenceRow>();
}

async function resumeScheduleOccurrence(env: D1AppEnv, occurrence: ScheduleOccurrenceRow) {
  try {
    if (!occurrence.game_initialized_at) {
      const gameRow = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(occurrence.game_id).first<GameRow>();
      if (!gameRow) throw new Error("Occurrence game is missing.");
      await ensureD1GameInitialized(env, gameRow);
      await env.DB.prepare(`
        UPDATE schedule_occurrences SET game_initialized_at = COALESCE(game_initialized_at, ?), last_error = NULL
        WHERE occurrence_key = ?
      `).bind(Date.now(), occurrence.occurrence_key).run();
    }
    if (!occurrence.from_push_enqueued_at) {
      await enqueuePushEvent(
        env,
        `schedule:${occurrence.occurrence_key}:${occurrence.from_id}`,
        occurrence.from_id,
        "scheduled_start",
        `Your game with @${occurrence.to_handle} is starting`,
        `/game/${occurrence.game_id}`,
        "SELECT 1 FROM schedule_occurrences WHERE occurrence_key = ?",
        [occurrence.occurrence_key],
      );
      await env.DB.prepare(`
        UPDATE schedule_occurrences SET from_push_enqueued_at = COALESCE(from_push_enqueued_at, ?)
        WHERE occurrence_key = ?
      `).bind(Date.now(), occurrence.occurrence_key).run();
    }
    if (!occurrence.to_push_enqueued_at) {
      await enqueuePushEvent(
        env,
        `schedule:${occurrence.occurrence_key}:${occurrence.to_id}`,
        occurrence.to_id,
        "scheduled_start",
        `Your game with @${occurrence.from_handle} is starting`,
        `/game/${occurrence.game_id}`,
        "SELECT 1 FROM schedule_occurrences WHERE occurrence_key = ?",
        [occurrence.occurrence_key],
      );
      await env.DB.prepare(`
        UPDATE schedule_occurrences SET to_push_enqueued_at = COALESCE(to_push_enqueued_at, ?)
        WHERE occurrence_key = ?
      `).bind(Date.now(), occurrence.occurrence_key).run();
    }
    await Promise.all([
      deliverPushEvent(env, `schedule:${occurrence.occurrence_key}:${occurrence.from_id}`),
      deliverPushEvent(env, `schedule:${occurrence.occurrence_key}:${occurrence.to_id}`),
    ]);
    await env.DB.prepare(`
      UPDATE schedule_occurrences SET effects_completed_at = COALESCE(effects_completed_at, ?), retry_at = ?, last_error = NULL
      WHERE occurrence_key = ?
    `).bind(Date.now(), Date.now(), occurrence.occurrence_key).run();
  } catch (error) {
    const attempts = occurrence.attempts + 1;
    const retryAt = Date.now() + Math.min(5 * 60_000, 2_000 * 2 ** Math.min(attempts - 1, 8));
    await env.DB.prepare(`
      UPDATE schedule_occurrences SET attempts = attempts + 1, retry_at = ?, last_error = ?
      WHERE occurrence_key = ? AND effects_completed_at IS NULL
    `).bind(retryAt, error instanceof Error ? error.message.slice(0, 500) : "Occurrence failed", occurrence.occurrence_key).run();
  }
}

async function retryScheduledPushes(env: D1AppEnv, now: number) {
  const events = await env.DB.prepare(`
    SELECT DISTINCT event_key FROM pending_pushes
    WHERE event_key LIKE 'schedule:%' AND endpoint <> '' AND next_attempt_at <= ? AND expires_at > ?
    ORDER BY next_attempt_at LIMIT ?
  `).bind(now, now, SCHEDULER_BATCH_SIZE * 2).all<{ event_key: string }>();
  for (const event of events.results) await deliverPushEvent(env, event.event_key);
}

export class SchedulerDO extends DurableObject<D1AppEnv> {
  constructor(ctx: DurableObjectState, env: D1AppEnv) {
    super(ctx, env);
  }

  async fetch(request: Request) {
    if (request.headers.get("x-internal") !== "worker") return json({ error: "Internal route." }, { status: 403 });
    const url = new URL(request.url);
    if (url.pathname === "/wake-no-later" && request.method === "POST") {
      const body = await readJson<{ candidate?: number; handoffId?: string }>(request);
      if (!Number.isFinite(body.candidate) || !body.handoffId || !/^wake_[A-Za-z0-9_-]+$/.test(body.handoffId)) {
        return json({ error: "Invalid wake handoff." }, { status: 400 });
      }
      const handoffs = await this.handoffs();
      const now = Date.now();
      handoffs[body.handoffId] = {
        candidate: Number(body.candidate),
        expiresAt: Math.max(now, Number(body.candidate)) + 2 * SCHEDULER_WATCHDOG_MS,
      };
      await this.ctx.storage.put("wakeHandoffs", handoffs);
      const current = await this.ctx.storage.getAlarm();
      const candidate = Math.max(now, Number(body.candidate));
      if (current === null || candidate < current) await this.ctx.storage.setAlarm(candidate);
      return json({ ok: true });
    }
    if (url.pathname === "/canonicalize" && request.method === "POST") {
      const body = await readJson<{ handoffId?: string }>(request).catch(() => ({} as { handoffId?: string }));
      if (body.handoffId) {
        const handoffs = await this.handoffs();
        delete handoffs[body.handoffId];
        if (Object.keys(handoffs).length) await this.ctx.storage.put("wakeHandoffs", handoffs);
        else await this.ctx.storage.delete("wakeHandoffs");
      }
      await this.canonicalize();
      return json({ ok: true });
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete("wakeHandoffs");
      return json({ ok: true });
    }
    if (url.pathname === "/debug-run" && request.method === "POST") {
      await this.alarm();
      return json({ ok: true });
    }
    return json({ error: "Not found" }, { status: 404 });
  }

  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + SCHEDULER_WATCHDOG_MS);
    const now = Date.now();
    await this.env.DB.prepare(`
      UPDATE schedules SET status = 'expired', updated_at = ?
      WHERE status = 'pending' AND start_at + ? <= ?
    `).bind(now, SCHEDULE_PENDING_GRACE_MS, now).run();
    await claimDueScheduleOccurrences(this.env, now);
    const unfinished = await unfinishedScheduleOccurrences(this.env, now);
    for (const occurrence of unfinished.results) await resumeScheduleOccurrence(this.env, occurrence);
    await retryScheduledPushes(this.env, now);
    await this.canonicalize();
  }

  private async handoffs() {
    return (await this.ctx.storage.get<Record<string, { candidate: number; expiresAt: number }>>("wakeHandoffs")) || {};
  }

  private async canonicalize() {
    const handoffs = await this.handoffs();
    const now = Date.now();
    let pruned = false;
    for (const [id, handoff] of Object.entries(handoffs)) {
      if (handoff.expiresAt <= now) {
        delete handoffs[id];
        pruned = true;
      }
    }
    if (pruned && Object.keys(handoffs).length) await this.ctx.storage.put("wakeHandoffs", handoffs);
    else if (pruned) await this.ctx.storage.delete("wakeHandoffs");
    const databaseDeadline = await canonicalSchedulerDeadline(this.env.DB);
    const handoffDeadline = Object.values(handoffs).reduce<number | null>((minimum, handoff) => {
      const candidate = handoff.candidate <= now ? now + SCHEDULER_WATCHDOG_MS : handoff.candidate;
      return minimum === null ? candidate : Math.min(minimum, candidate);
    }, null);
    const deadline = databaseDeadline === null
      ? handoffDeadline
      : handoffDeadline === null ? databaseDeadline : Math.min(databaseDeadline, handoffDeadline);
    if (deadline === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 250, deadline));
  }
}
