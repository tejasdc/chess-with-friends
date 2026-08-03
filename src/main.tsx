import React, { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import "./styles.css";

type TimeControl = "10|0" | "5|0";
type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";
type PushStatus = "checking" | "ready" | "enabled" | "blocked" | "unsupported";

interface Friend { id: string; handle: string; online: boolean }
interface FriendRequest { id: string; fromHandle?: string; toHandle?: string }
interface Challenge { id: string; fromHandle?: string; toHandle?: string; timeControl: TimeControl }
interface Schedule {
  id: string;
  fromId: string;
  toId: string;
  fromHandle?: string;
  toHandle?: string;
  timeControl: TimeControl;
  startAt: number;
  status: "pending" | "accepted" | "fired" | "declined";
  gameId?: string;
}
interface GameMeta {
  id: string;
  whiteId: string;
  blackId: string;
  timeControl: TimeControl;
  status: GameStatus;
  result?: string;
}
interface HomeData {
  user: { id: string; handle: string; inviteToken: string };
  inviteUrl: string;
  friends: Friend[];
  requests: FriendRequest[];
  sentRequests: FriendRequest[];
  challenges: Challenge[];
  sentChallenges: Challenge[];
  schedules: Schedule[];
  games: GameMeta[];
  pushPublicKey: string;
  pushTypes: string[];
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
  lastTickAt: number;
  turn: "w" | "b";
  status: GameStatus;
  result?: string;
  winnerId?: string;
  loserId?: string;
  connectionState: Record<string, "connected" | "reconnecting" | "gone">;
}

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
const pieceNames: Record<PieceSymbol, string> = {
  p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king",
};
const whiteGlyphs: Record<PieceSymbol, string> = { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" };
const blackGlyphs: Record<PieceSymbol, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

// Lazy-load the 3D wallet scene so unauthenticated first-paint stays
// lean; three.js only lands on the wire when the auth screen mounts.
const WalletScene = lazy(() => import("./WalletScene"));

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    // Explicit — modern browsers default to same-origin, but Safari's
    // service-worker fetch interception has bit us before. Being explicit
    // guarantees the session cookie rides on every /api call.
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data as T;
}

function App() {
  const [home, setHome] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const path = usePathname();
  const gameMatch = path.match(/^\/game\/([^/]+)/);
  const inviteMatch = path.match(/^\/invite\/([^/]+)/);

  async function refresh() {
    try {
      const data = await api<HomeData>("/api/me");
      setHome(data);
    } catch {
      setHome(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void api<HomeData>("/api/presence/heartbeat", { method: "POST", body: "{}" })
        .then(setHome)
        .catch(() => undefined);
    }, 10000);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    return () => window.clearInterval(timer);
  }, []);

  if (loading) return <Shell onSignedOut={() => setHome(null)}><LoadingLine /></Shell>;
  if (!home) return <AuthScreen onSignedIn={refresh} message={message} setMessage={setMessage} />;
  if (gameMatch) return <GameScreen gameId={gameMatch[1]} home={home} onHome={() => navigate("/", refresh)} setMessage={setMessage} />;

  return (
    <Shell home={home} message={message} setMessage={setMessage} onSignedOut={() => setHome(null)}>
      <Dashboard home={home} inviteToken={inviteMatch?.[1]} refresh={refresh} setMessage={setMessage} />
    </Shell>
  );
}

function Shell({
  children,
  home,
  message,
  setMessage,
  onSignedOut,
}: {
  children?: React.ReactNode;
  home?: HomeData | null;
  message?: string;
  setMessage?: (value: string) => void;
  onSignedOut?: () => void;
}) {
  return (
    <main className="shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate("/")}>Chess with friends</button>
        {home ? (
          <div className="account">
            <span className="handle">@{home.user.handle}</span>
            <button className="ghost" onClick={() => void signOut(onSignedOut || (() => undefined))}>Sign out</button>
          </div>
        ) : null}
      </header>
      {message ? (
        <div className="notice" role="status">
          <span>{message}</span>
          {setMessage ? (
            <button className="ghost tiny" aria-label="Dismiss" onClick={() => setMessage("")}>×</button>
          ) : null}
        </div>
      ) : null}
      <div className="stage">{children}</div>
    </main>
  );
}

function LoadingLine() {
  return <p className="muted center">Opening board…</p>;
}

// Realtime game channel — resilient WebSocket that reconnects on
// close/error with backoff, resyncs on every reconnect (both by sending
// "sync" and by requesting a fresh REST snapshot via onResync), wakes
// on visibilitychange when the tab comes back, and detects silent
// half-open sockets via a ping/pong heartbeat. Every path re-arms
// itself, so the board can never silently freeze — the failure mode
// this replaces was a dead socket that never noticed it was dead.
function useRealtimeGame(
  gameId: string,
  {
    onGame,
    onResync,
    enabled,
  }: {
    onGame: (game: GameState) => void;
    onResync: () => Promise<void> | void;
    enabled: boolean;
  },
) {
  const onGameRef = React.useRef(onGame);
  const onResyncRef = React.useRef(onResync);
  onGameRef.current = onGame;
  onResyncRef.current = onResync;

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let backoffMs = 250;
    let reconnectTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let livenessTimer: number | null = null;
    let disposed = false;
    let lastInboundAt = Date.now();

    const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/games/${gameId}/socket`;

    function clearTimers() {
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (livenessTimer !== null) window.clearInterval(livenessTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      heartbeatTimer = null;
      livenessTimer = null;
      reconnectTimer = null;
    }

    function scheduleReconnect() {
      if (disposed) return;
      clearTimers();
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 5000);
      reconnectTimer = window.setTimeout(connect, delay);
    }

    function connect() {
      if (disposed) return;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      const s = socket;
      s.addEventListener("open", () => {
        backoffMs = 250;
        lastInboundAt = Date.now();
        try { s.send("sync"); } catch { /* dead almost immediately */ }
        // Belt-and-suspenders REST resync in case a broadcast fired
        // between the last disconnect and this reconnect.
        void onResyncRef.current();
        // Heartbeat: send a ping every 15s so the server has a reason to
        // reply and we can see inbound traffic on a healthy socket.
        heartbeatTimer = window.setInterval(() => {
          try { s.send("ping"); } catch { /* will surface via liveness */ }
        }, 15000);
        // Liveness: if no inbound frame for 25s during an active game,
        // treat the socket as half-open. Close it (that fires close →
        // scheduleReconnect).
        livenessTimer = window.setInterval(() => {
          if (Date.now() - lastInboundAt > 25000) {
            try { s.close(); } catch { /* ignored */ }
          }
        }, 5000);
      });
      s.addEventListener("message", (event) => {
        lastInboundAt = Date.now();
        const raw = typeof event.data === "string" ? event.data : "";
        if (!raw || raw === "pong") return;
        try {
          const payload = JSON.parse(raw);
          if (payload && payload.game) onGameRef.current(payload.game as GameState);
        } catch { /* non-JSON frame ignored */ }
      });
      s.addEventListener("close", () => {
        clearTimers();
        scheduleReconnect();
      });
      s.addEventListener("error", () => {
        try { s.close(); } catch { /* already closing */ }
      });
    }

    function onVisibility() {
      if (document.visibilityState !== "visible") return;
      // Coming back into the foreground: if the socket isn't already
      // OPEN, force an immediate reconnect (don't wait for backoff).
      const state = socket?.readyState;
      if (state === WebSocket.OPEN) {
        try { socket?.send("sync"); } catch { /* trigger reconnect */ }
        void onResyncRef.current();
        return;
      }
      try { socket?.close(); } catch { /* ignored */ }
      backoffMs = 250;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    }

    document.addEventListener("visibilitychange", onVisibility);
    connect();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimers();
      try { socket?.close(); } catch { /* ignored */ }
      socket = null;
    };
  }, [gameId, enabled]);
}

function presenceLabel(state: "connected" | "reconnecting" | "gone", _handle: string): string {
  // Softer wording than raw state — "gone" reads insane at a glance;
  // "offline" is what a person would say. "away" carries the shorter
  // interruption that iOS lock/tab-switch produces without alarming.
  if (state === "connected") return "here";
  if (state === "reconnecting") return "away";
  return "offline";
}

function usePathname() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return path;
}

function AuthScreen({
  onSignedIn,
  message,
  setMessage,
}: {
  onSignedIn: () => void;
  message: string;
  setMessage: (value: string) => void;
}) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  // Preflight probe result: does this handle already have an account? Determined
  // silently on input-debounce so Continue can run the right flow inside a
  // single click's user activation (WebAuthn will not chain two credential
  // prompts across separate activations reliably on all engines).
  const [flow, setFlow] = useState<"login" | "register" | "unknown">("unknown");

  useEffect(() => {
    const trimmed = handle.trim();
    if (!trimmed) {
      setFlow("unknown");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        await api("/api/auth/login/options", { method: "POST", body: JSON.stringify({ handle: trimmed }) });
        if (!cancelled) setFlow("login");
      } catch (error) {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : "";
        setFlow(/no account/i.test(text) ? "register" : "login");
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [handle]);

  async function submit() {
    if (!handle || busy) return;
    setBusy(true);
    try {
      // If the probe hasn't landed yet, do it inline — still a single user
      // gesture from the browser's perspective for the credential call that
      // follows, and cheaper than forcing a second click.
      let decided = flow;
      if (decided === "unknown") {
        try {
          await api<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options", {
            method: "POST",
            body: JSON.stringify({ handle }),
          });
          decided = "login";
        } catch (error) {
          const text = error instanceof Error ? error.message : "";
          decided = /no account/i.test(text) ? "register" : "login";
        }
      }

      if (decided === "register") {
        const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>("/api/auth/register/options", {
          method: "POST",
          body: JSON.stringify({ handle }),
        });
        const response = await startRegistration({ optionsJSON });
        await api("/api/auth/register/verify", { method: "POST", body: JSON.stringify({ handle, response }) });
      } else {
        const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options", {
          method: "POST",
          body: JSON.stringify({ handle }),
        });
        const response = await startAuthentication({ optionsJSON });
        await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ handle, response }) });
      }
      await onSignedIn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell message={message} setMessage={setMessage}>
      <section className="auth">
        <div className="auth-scene" aria-hidden="true">
          <Suspense fallback={<div className="auth-scene-fallback">Opening the wallet…</div>}>
            <WalletScene />
          </Suspense>
        </div>
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span className="field-label">Handle</span>
            <input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="your_handle"
              autoComplete="username webauthn"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <button className="primary" type="submit" disabled={busy || !handle}>
            {busy ? "Working…" : "Continue"}
          </button>
          <p className="footnote">Passkeys only — no password, no email.</p>
        </form>
      </section>
    </Shell>
  );
}

function Dashboard({
  home,
  inviteToken,
  refresh,
  setMessage,
}: {
  home: HomeData;
  inviteToken?: string;
  refresh: () => void;
  setMessage: (value: string) => void;
}) {
  return (
    <div className="dashboard">
      <InstallPrompt home={home} setMessage={setMessage} />
      {inviteToken ? <InvitePanel token={inviteToken} refresh={refresh} setMessage={setMessage} /> : null}
      <IncomingPanel home={home} refresh={refresh} />
      <GamesSection games={home.games} />
      <PlaySection home={home} refresh={refresh} setMessage={setMessage} />
      <FriendsSection home={home} refresh={refresh} setMessage={setMessage} />
    </div>
  );
}

function InstallPrompt({ home, setMessage }: { home: HomeData; setMessage: (value: string) => void }) {
  const [pushStatus, setPushStatus] = useState<PushStatus>("checking");
  const [installed, setInstalled] = useState<boolean>(() => detectInstalled());

  async function checkPushStatus() {
    if (!home.pushPublicKey || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushStatus("blocked");
      return;
    }
    if (Notification.permission !== "granted") {
      setPushStatus("ready");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    setPushStatus(subscription ? "enabled" : "ready");
  }

  useEffect(() => {
    void checkPushStatus().catch(() => setPushStatus("ready"));
    const media = window.matchMedia("(display-mode: standalone)");
    const update = () => setInstalled(detectInstalled());
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [home.pushPublicKey]);

  async function enablePush() {
    try {
      if (!home.pushPublicKey) throw new Error("Push key is not configured on this deployment.");
      if (!("Notification" in window)) throw new Error("Notifications are not supported in this browser.");
      if (Notification.permission === "denied") throw new Error("Notifications are blocked in this browser.");
      if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("Notification permission was not granted.");
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(home.pushPublicKey),
      });
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription }) });
      await checkPushStatus();
      setMessage("Notifications enabled for friend requests, challenges, and scheduled games.");
    } catch (error) {
      await checkPushStatus().catch(() => undefined);
      setMessage(error instanceof Error ? error.message : "Notification setup failed.");
    }
  }

  // Install guidance and notification enablement are independent. Show
  // install guidance whenever the app isn't launched from the Home Screen
  // (this matters ESPECIALLY in private browsing where push is unsupported
  // — that's the one case where the user most needs install instructions).
  const showInstall = !installed;
  const showEnablePush = pushStatus === "ready";
  const showBlocked = pushStatus === "blocked";
  const showEnabled = pushStatus === "enabled";

  if (!showInstall && !showEnablePush && !showBlocked) return null;

  return (
    <div className="install-strip">
      {showInstall ? (
        <div className="install-block">
          <p className="install-title">Install to your Home Screen</p>
          <p className="install-body">
            iPhone: open Share, choose Add to Home Screen. Android/Chrome: menu → Install app.
          </p>
        </div>
      ) : null}
      {showEnablePush ? (
        <button className="ghost" onClick={enablePush}>Enable notifications</button>
      ) : null}
      {showBlocked && !showInstall ? (
        <p className="install-body">Notifications are blocked in this browser.</p>
      ) : null}
      {showEnabled ? null : null}
    </div>
  );
}

function detectInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(standalone || iosStandalone);
}

function InvitePanel({
  token,
  refresh,
  setMessage,
}: {
  token: string;
  refresh: () => void;
  setMessage: (value: string) => void;
}) {
  async function send() {
    try {
      await api("/api/friends/invite", { method: "POST", body: JSON.stringify({ token }) });
      setMessage("Friend request sent from invite link.");
      navigate("/", refresh);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invite failed.");
    }
  }
  return (
    <section className="invite">
      <p>Someone invited you.</p>
      <button className="primary" onClick={send}>Send friend request</button>
    </section>
  );
}

function IncomingPanel({ home, refresh }: { home: HomeData; refresh: () => void }) {
  async function acceptFriend(id: string) {
    await api(`/api/friends/${id}/accept`, { method: "POST", body: "{}" });
    await refresh();
  }
  async function acceptChallenge(id: string) {
    const { game } = await api<{ game: GameMeta }>(`/api/challenges/${id}/accept`, { method: "POST", body: "{}" });
    navigate(`/game/${game.id}`);
  }
  async function acceptSchedule(id: string) {
    await api(`/api/schedules/${id}/accept`, { method: "POST", body: "{}" });
    await refresh();
  }

  const items: Array<{ key: string; label: React.ReactNode; onAccept: () => void }> = [
    ...home.requests.map((request) => ({
      key: `f-${request.id}`,
      label: <><strong>@{request.fromHandle}</strong> wants to be friends</>,
      onAccept: () => void acceptFriend(request.id),
    })),
    ...home.challenges.map((challenge) => ({
      key: `c-${challenge.id}`,
      label: <><strong>@{challenge.fromHandle}</strong> challenged you · {challenge.timeControl}</>,
      onAccept: () => void acceptChallenge(challenge.id),
    })),
    ...home.schedules
      .filter((schedule) => schedule.toId === home.user.id && schedule.status === "pending")
      .map((schedule) => ({
        key: `s-${schedule.id}`,
        label: (
          <>
            <strong>@{schedule.fromHandle}</strong> proposed{" "}
            {new Date(schedule.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ·{" "}
            {schedule.timeControl}
          </>
        ),
        onAccept: () => void acceptSchedule(schedule.id),
      })),
  ];

  if (!items.length) return null;

  return (
    <section className="incoming">
      {items.map((item) => (
        <div className="incoming-row" key={item.key}>
          <span>{item.label}</span>
          <button className="primary compact" onClick={item.onAccept}>Accept</button>
        </div>
      ))}
    </section>
  );
}

function GamesSection({ games }: { games: GameMeta[] }) {
  if (!games.length) return null;
  const active = games.filter((game) => game.status === "active");
  const past = games.filter((game) => game.status !== "active");
  return (
    <section className="games">
      <h2 className="section-title">Games</h2>
      <div className="game-rows">
        {active.map((game) => (
          <GameRow key={game.id} game={game} accent />
        ))}
        {past.slice(0, 4).map((game) => (
          <GameRow key={game.id} game={game} />
        ))}
      </div>
    </section>
  );
}

function GameRow({ game, accent }: { game: GameMeta; accent?: boolean }) {
  const status = game.status === "active" ? "in play" : game.result || game.status;
  return (
    <button className={`game-row ${accent ? "accent" : ""}`} onClick={() => navigate(`/game/${game.id}`)}>
      <span className="row-mono">{game.timeControl}</span>
      <span className="row-status">{status}</span>
      <span className="row-arrow" aria-hidden="true">→</span>
    </button>
  );
}

function PlaySection({
  home,
  refresh,
  setMessage,
}: {
  home: HomeData;
  refresh: () => void;
  setMessage: (value: string) => void;
}) {
  const [friendId, setFriendId] = useState(home.friends[0]?.id || "");
  const [timeControl, setTimeControl] = useState<TimeControl>("10|0");
  const [minutes, setMinutes] = useState("10");
  const [mode, setMode] = useState<"now" | "later">("now");

  useEffect(() => {
    if (!friendId && home.friends[0]) setFriendId(home.friends[0].id);
  }, [friendId, home.friends]);

  async function sendChallenge() {
    try {
      await api("/api/challenges", { method: "POST", body: JSON.stringify({ friendId, timeControl }) });
      setMessage("Challenge sent.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Challenge failed.");
    }
  }

  async function propose() {
    try {
      const startAt = Date.now() + Math.max(0.02, Number(minutes)) * 60 * 1000;
      await api("/api/schedules", { method: "POST", body: JSON.stringify({ friendId, timeControl, startAt }) });
      setMessage("Game time proposed.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule failed.");
    }
  }

  const outgoingSchedules = home.schedules.filter(
    (schedule) => schedule.fromId === home.user.id || (schedule.toId === home.user.id && schedule.status !== "pending"),
  );

  return (
    <section className="play">
      <div className="section-heading">
        <h2 className="section-title">Play</h2>
        <div className="tabs" role="tablist">
          <button
            className={`tab ${mode === "now" ? "active" : ""}`}
            role="tab"
            aria-selected={mode === "now"}
            onClick={() => setMode("now")}
          >
            Now
          </button>
          <button
            className={`tab ${mode === "later" ? "active" : ""}`}
            role="tab"
            aria-selected={mode === "later"}
            onClick={() => setMode("later")}
          >
            Schedule
          </button>
        </div>
      </div>

      {home.friends.length === 0 ? (
        <p className="muted">Add a friend to start a game.</p>
      ) : (
        <div className="play-form">
          <label className="field">
            <span className="field-label">Friend</span>
            <FriendSelect friends={home.friends} value={friendId} onChange={setFriendId} />
          </label>
          <label className="field">
            <span className="field-label">Time control</span>
            <TimeSelect value={timeControl} onChange={setTimeControl} />
          </label>
          {mode === "later" ? (
            <label className="field">
              <span className="field-label">Start in minutes</span>
              <input value={minutes} onChange={(event) => setMinutes(event.target.value)} inputMode="decimal" />
            </label>
          ) : null}
          <div className="play-action">
            {mode === "now" ? (
              <button className="primary" onClick={sendChallenge} disabled={!friendId}>Send</button>
            ) : (
              <button className="primary" onClick={propose} disabled={!friendId}>Propose</button>
            )}
          </div>
        </div>
      )}

      {home.sentChallenges.length ? (
        <ul className="pending">
          {home.sentChallenges.map((challenge) => (
            <li key={challenge.id}>Challenge sent to @{challenge.toHandle}</li>
          ))}
        </ul>
      ) : null}
      {outgoingSchedules.length ? (
        <ul className="pending">
          {outgoingSchedules.map((schedule) => (
            <li key={schedule.id}>
              @{schedule.fromHandle} → @{schedule.toHandle}{" "}
              · {new Date(schedule.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}{" "}
              · {scheduleStatus(schedule.status)}
              {schedule.gameId ? (
                <button className="link" onClick={() => navigate(`/game/${schedule.gameId}`)}>Open</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function FriendsSection({
  home,
  refresh,
  setMessage,
}: {
  home: HomeData;
  refresh: () => void;
  setMessage: (value: string) => void;
}) {
  const [handle, setHandle] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const invite = `${window.location.origin}${home.inviteUrl}`;

  async function requestFriend() {
    try {
      await api("/api/friends/request", { method: "POST", body: JSON.stringify({ handle }) });
      setHandle("");
      setMessage("Friend request sent.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Friend request failed.");
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(invite);
      setMessage("Invite link copied.");
    } catch {
      setShowInvite(true);
    }
  }

  return (
    <section className="friends">
      <div className="section-heading">
        <h2 className="section-title">Friends</h2>
        <button className="ghost" onClick={copyInvite}>Copy invite link</button>
      </div>

      <div className="add-friend">
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder="friend_handle"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="primary" onClick={requestFriend} disabled={!handle}>Add</button>
      </div>

      {showInvite ? <p className="invite-fallback">{invite}</p> : null}

      {home.sentRequests.length ? (
        <ul className="pending">
          {home.sentRequests.map((request) => (
            <li key={request.id}>Request sent to @{request.toHandle}</li>
          ))}
        </ul>
      ) : null}

      {home.friends.length ? (
        <ul className="friend-list">
          {home.friends.map((friend) => (
            <li className="friend-card" key={friend.id}>
              <span className="friend-handle">@{friend.handle}</span>
              <span className={`presence ${friend.online ? "online" : "offline"}`}>
                <span className="dot" aria-hidden="true" />
                {friend.online ? "online" : "offline"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No friends yet. Share your invite link.</p>
      )}
    </section>
  );
}

function GameScreen({
  gameId,
  home,
  onHome,
  setMessage,
}: {
  gameId: string;
  home: HomeData;
  onHome: () => void;
  setMessage: (value: string) => void;
}) {
  const [game, setGame] = useState<GameState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selected, setSelected] = useState<Square | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [now, setNow] = useState(Date.now());
  const myColor = game?.whiteId === home.user.id ? "w" : "b";
  const opponentId = game ? (game.whiteId === home.user.id ? game.blackId : game.whiteId) : "";
  const opponentRawState = game?.connectionState?.[opponentId] || "gone";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<GameState>(`/api/games/${gameId}/state`);
        if (!cancelled) {
          setGame(data);
          setLoadError(null);
        }
      } catch (error) {
        if (cancelled) return;
        const text = error instanceof Error ? error.message : "Could not load this game.";
        setLoadError(text);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, loadAttempt]);

  // Resilient realtime channel. Reconnects on close/error with backoff,
  // resyncs (via REST snapshot) on every reconnect, wakes on visibility
  // return, and treats a silent socket as half-open via ping/pong heartbeat.
  useRealtimeGame(gameId, {
    onGame: (next) => {
      setGame(next);
      setLoadError(null);
    },
    onResync: async () => {
      try {
        const data = await api<GameState>(`/api/games/${gameId}/state`);
        setGame(data);
        setLoadError(null);
      } catch {
        // Silent — REST resync failure just means we wait for the next
        // socket message; the socket itself is separately reconnecting.
      }
    },
    enabled: !!game && game.status === "active",
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function choose(square: Square) {
    if (!game || game.status !== "active") return;
    if (!selected) {
      setSelected(square);
      return;
    }
    try {
      const next = await api<GameState>(`/api/games/${gameId}/move`, {
        method: "POST",
        body: JSON.stringify({ from: selected, to: square, promotion: "q" }),
      });
      setGame(next);
      setSelected(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Move failed.");
      setSelected(null);
    }
  }

  async function resign() {
    const next = await api<GameState>(`/api/games/${gameId}/resign`, { method: "POST", body: "{}" });
    setGame(next);
    setConfirmResign(false);
  }

  if (loadError) {
    return (
      <Shell home={home}>
        <section className="game-error">
          <h2 className="section-title">Can't open this game</h2>
          <p className="muted">{loadError}</p>
          <div className="game-actions">
            <button className="primary" onClick={() => setLoadAttempt((n) => n + 1)}>Try again</button>
            <button className="ghost" onClick={onHome}>Home</button>
          </div>
        </section>
      </Shell>
    );
  }
  if (!game) return <Shell home={home}><LoadingLine /></Shell>;

  const opponentHandle = myColor === "w" ? game.blackHandle : game.whiteHandle;
  const myHandle = myColor === "w" ? game.whiteHandle : game.blackHandle;
  const opponentColor: "w" | "b" = myColor === "w" ? "b" : "w";
  const opponentClock = liveClock(game, opponentColor, now);
  const myClock = liveClock(game, myColor, now);
  const opponentPresence = presenceLabel(opponentRawState, opponentHandle);

  return (
    <Shell home={home}>
      <section className="game">
        <div className="board-column">
          <div className="clock-strip top">
            <div className="who">
              <span className="handle-line">@{opponentHandle}</span>
              <span className={`connection ${opponentRawState}`}>{opponentPresence}</span>
            </div>
            <time className="clock">{formatClock(opponentClock)}</time>
          </div>

          <div className="board-holder">
            <Board fen={game.fen} orientation={myColor || "w"} selected={selected} onSquare={choose} />
          </div>

          <div className="clock-strip bottom">
            <div className="who">
              <span className="handle-line">@{myHandle}</span>
              <span className="you">you</span>
            </div>
            <time className="clock">{formatClock(myClock)}</time>
          </div>
        </div>

        <aside className="game-side">
          <div className="game-status">
            {game.status === "active" ? (
              <span>{game.turn === myColor ? "Your move" : "Their move"}</span>
            ) : (
              <span className="terminal">
                {game.status}
                {game.result ? ` · ${game.result}` : ""}
              </span>
            )}
          </div>

          <div className="game-actions">
            <button className="ghost" onClick={onHome}>Home</button>
            {confirmResign ? (
              <>
                <button className="danger" onClick={() => void resign()} disabled={game.status !== "active"}>
                  Confirm resign
                </button>
                <button className="ghost" onClick={() => setConfirmResign(false)}>Cancel</button>
              </>
            ) : (
              <button className="ghost warn" onClick={() => setConfirmResign(true)} disabled={game.status !== "active"}>
                Resign
              </button>
            )}
          </div>

          {game.moves.length ? (
            <ol className="moves">
              {game.moves.map((move, index) => (
                <li key={`${move.at}-${index}`}>
                  <span className="move-num">{Math.floor(index / 2) + 1}{index % 2 ? "…" : "."}</span>
                  <span className="move-san">{move.san}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </aside>
      </section>
    </Shell>
  );
}

function Board({
  fen,
  orientation,
  selected,
  onSquare,
  interactive = true,
}: {
  fen: string;
  orientation: "w" | "b";
  selected: Square | null;
  onSquare: (square: Square) => void;
  interactive?: boolean;
}) {
  const chess = useMemo(() => new Chess(fen), [fen]);
  const board = chess.board();
  const rankList = orientation === "w" ? ranks : [...ranks].reverse();
  const fileList = orientation === "w" ? files : [...files].reverse();
  return (
    <div
      className={`board ${interactive ? "" : "board-static"}`}
      role={interactive ? "grid" : "presentation"}
      aria-label={interactive ? "Chess board" : undefined}
    >
      {rankList.flatMap((rank) =>
        fileList.map((file) => {
          const square = `${file}${rank}` as Square;
          const piece = board[8 - Number(rank)][files.indexOf(file)];
          const dark = (files.indexOf(file) + Number(rank)) % 2 === 0;
          const showFile = orientation === "w" ? rank === "1" : rank === "8";
          const showRank = orientation === "w" ? file === "a" : file === "h";
          if (!interactive) {
            return (
              <div
                className={`square ${dark ? "dark" : "light"}`}
                data-square={square}
                key={square}
              >
                {showRank ? <span className="coord coord-rank">{rank}</span> : null}
                {showFile ? <span className="coord coord-file">{file}</span> : null}
                {piece ? <PieceGlyph color={piece.color} type={piece.type} /> : null}
              </div>
            );
          }
          return (
            <button
              className={`square ${dark ? "dark" : "light"} ${selected === square ? "selected" : ""}`}
              data-square={square}
              key={square}
              onClick={() => void onSquare(square)}
              aria-label={square}
            >
              {showRank ? <span className="coord coord-rank" aria-hidden="true">{rank}</span> : null}
              {showFile ? <span className="coord coord-file" aria-hidden="true">{file}</span> : null}
              {piece ? <PieceGlyph color={piece.color} type={piece.type} /> : null}
            </button>
          );
        }),
      )}
    </div>
  );
}

function FriendSelect({
  friends,
  value,
  onChange,
}: {
  friends: Friend[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Friend">
      <option value="">Choose a friend</option>
      {friends.map((friend) => (
        <option key={friend.id} value={friend.id}>@{friend.handle}</option>
      ))}
    </select>
  );
}

function TimeSelect({ value, onChange }: { value: TimeControl; onChange: (value: TimeControl) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as TimeControl)} aria-label="Time control">
      <option value="10|0">10 min</option>
      <option value="5|0">5 min</option>
    </select>
  );
}

function PieceGlyph({ color, type }: { color: Color; type: PieceSymbol }) {
  const glyph = color === "w" ? whiteGlyphs[type] : blackGlyphs[type];
  const title = `${color === "w" ? "white" : "black"} ${pieceNames[type]}`;
  return (
    <span className={`piece piece-${color}`} role="img" aria-label={title}>
      {glyph}
    </span>
  );
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60).toString();
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function liveClock(game: GameState, color: "w" | "b", now: number) {
  if (game.status !== "active" || game.turn !== color) return color === "w" ? game.whiteMs : game.blackMs;
  return (color === "w" ? game.whiteMs : game.blackMs) - Math.max(0, now - game.lastTickAt);
}

function scheduleStatus(status: Schedule["status"]) {
  if (status === "fired") return "ready";
  return status;
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function signOut(onSignedOut: () => void) {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  // Clear in-memory identity FIRST so the AuthScreen renders immediately —
  // the previous version pushState-only'd and left the dashboard mounted
  // with stale home data. Then push the URL so future refresh() sees "/".
  onSignedOut();
  window.history.pushState({}, "", "/");
}

function navigate(path: string, after?: () => void) {
  window.history.pushState({}, "", path);
  if (after) void after();
  window.dispatchEvent(new PopStateEvent("popstate"));
}

createRoot(document.getElementById("root")!).render(<App />);
