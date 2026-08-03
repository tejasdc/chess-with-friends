import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import "./styles.css";

// Standard starting position — the auth screen shows a real, static board
// in this position so the OBJECT arrives before any framing text does
// (per Rodchenko's chess table: the furniture IS the invitation to play).
const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

type TimeControl = "10|0" | "5|0";
type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";
type PushStatus = "checking" | "ready" | "enabled" | "blocked" | "unsupported";
type ToastKind = "info" | "error";
type SetMessage = (value: string, kind?: ToastKind) => void;

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
// FILLED Unicode glyphs used for BOTH colors — the outline "white" glyphs
// (♔♕♖♗♘♙) have transparent interiors, so on walnut squares the walnut
// bleeds through and white pieces read as mud with a whisper-thin edge.
// This is what physical sets do: Hartwig's whites are pale wood, not
// wireframes. Colour differentiates the sides; the glyph is the same shape.
const filledGlyphs: Record<PieceSymbol, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
// Legacy names kept in case anything else in the module reaches for them.
const whiteGlyphs = filledGlyphs;
const blackGlyphs = filledGlyphs;

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
  const [message, setMessageState] = useState("");
  const [messageKind, setMessageKind] = useState<ToastKind>("info");
  // Widened setter — callers pass "error" as the second arg from catch
  // blocks to tint the toast vermillion. Default is "info" (paper toast,
  // hairline border) so existing setMessage("...") calls stay valid.
  const setMessage = React.useCallback<SetMessage>((value, kind = "info") => {
    setMessageState(value);
    setMessageKind(kind);
  }, []);
  // Auto-dismiss transient toasts after 4s. Re-fires whenever `message`
  // changes (single source of truth for the timer). Errors and info both
  // dismiss on the same cadence — team-lead's spec.
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessageState(""), 4000);
    return () => window.clearTimeout(t);
  }, [message]);
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
  if (!home) return <AuthScreen onSignedIn={refresh} message={message} messageKind={messageKind} setMessage={setMessage} />;
  if (gameMatch) return <GameScreen gameId={gameMatch[1]} home={home} message={message} messageKind={messageKind} setMessage={setMessage} onHome={() => navigate("/", refresh)} />;

  return (
    <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage} onSignedOut={() => setHome(null)}>
      <Dashboard home={home} inviteToken={inviteMatch?.[1]} refresh={refresh} setMessage={setMessage} />
    </Shell>
  );
}

function Shell({
  children,
  home,
  message,
  messageKind,
  setMessage,
  onSignedOut,
}: {
  children?: React.ReactNode;
  home?: HomeData | null;
  message?: string;
  messageKind?: ToastKind;
  setMessage?: SetMessage;
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
      {/* Toast — fixed to viewport bottom, safe-area aware, auto-dismisses
          after 4s (timer in App). Renders OUTSIDE the topbar block so it
          floats above scrolled content. Kept inside Shell so it inherits
          the same shell-level z-context. */}
      {message ? (
        <div className={`toast ${messageKind === "error" ? "toast-error" : "toast-info"}`} role="status" aria-live="polite">
          <span>{message}</span>
          {setMessage ? (
            <button className="toast-dismiss" aria-label="Dismiss" onClick={() => setMessage("")}>×</button>
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
  // Aria-label wording only — the visible signal is a colored dot. Words
  // like "here"/"away" fought "offline" as antonyms; a dot doesn't lie.
  // These strings are consumed by screen readers and by the e2e suite via
  // getByRole("status", { name: ... }).
  if (state === "connected") return "opponent connected";
  if (state === "reconnecting") return "opponent reconnecting";
  return "opponent offline";
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
  messageKind,
  setMessage,
}: {
  onSignedIn: () => void;
  message: string;
  messageKind: ToastKind;
  setMessage: SetMessage;
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
    // `decided` is declared outside the try so the catch block can tailor
    // its toast to the flow that was actually attempted (Sarah-typing-taken-
    // handle case: the login path can fail with NotAllowedError when she
    // cancels the sheet or has no credential; the tailored recovery text
    // needs to know we were on the login branch).
    let decided: "login" | "register" = flow === "register" ? "register" : "login";
    try {
      // If the probe hasn't landed yet, do it inline — still a single user
      // gesture from the browser's perspective for the credential call that
      // follows, and cheaper than forcing a second click.
      if (flow === "unknown") {
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
      // Error taxonomy — never surface raw platform text. Tejas hit the
      // verbatim WebAuthn "The request is not allowed by the user agent
      // or the platform in the current context…" in the toast, which
      // reads as broken software.
      //
      // 1. NotAllowedError (WebAuthn cancel / dismiss / timeout) —
      //    almost always intentional. Silence is correct.
      // 2. Any other DOMException or platform-shaped error — short
      //    human line. Never the platform's own words.
      // 3. Regular Error from api() — the server message is already
      //    human-readable ("No account with that handle."). Surface it.
      const name = error instanceof Error ? error.name : "";
      const msg = error instanceof Error ? error.message : "";
      const isNotAllowed = name === "NotAllowedError" || /not allowed by the user agent/i.test(msg);
      if (isNotAllowed) return;   // silence
      const isPlatform = error instanceof DOMException
        || /^(Not|Invalid|Security|Timeout|Constraint|Abort|Unknown)[A-Z][A-Za-z]*Error$/.test(name)
        || /\bDOMException\b/i.test(msg);
      if (isPlatform) {
        setMessage("Sign in failed. Try again.", "error");
        return;
      }
      setMessage(msg || "Sign in failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  // Morphing button label — driven by the debounced handle-probe result.
  // Width is reserved in CSS (auth-primary min-width) so the row does NOT
  // jump when the label transitions. Empty/invalid state falls back to the
  // parallel-construction default.
  const trimmedHandle = handle.trim();
  const buttonLabel = busy
    ? "Working…"
    : !trimmedHandle
      ? "Sign in or sign up"
      : flow === "login"
        ? `Sign in as @${trimmedHandle}`
        : flow === "register"
          ? `Sign up as @${trimmedHandle}`
          : "Sign in or sign up";

  return (
    <Shell message={message} messageKind={messageKind} setMessage={setMessage}>
      <section className="auth">
        <div className="auth-scene" aria-hidden="true">
          <Board
            fen={INITIAL_FEN}
            orientation="w"
            selected={null}
            onSquare={() => undefined}
            interactive={false}
          />
        </div>
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {/* One row: input flexes, button fixed. The button label
              names the outcome ("Log in or create account") so we
              don't need a separate "HANDLE" label or a footnote —
              Apple's and Google's passkey sheets do the explaining. */}
          <div className="auth-row">
            <input
              className="auth-input"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="your_handle"
              autoComplete="username webauthn"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Handle"
            />
            <button className="auth-primary" type="submit" disabled={busy || !handle}>
              {buttonLabel}
            </button>
          </div>
          {/* Taken-handle UX is being rethought per Tejas's countermand —
              no subline / no recovery toast until that directive lands.
              The morphing button label stays. */}
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
  setMessage: SetMessage;
}) {
  return (
    <div className="dashboard">
      <InstallPrompt home={home} setMessage={setMessage} />
      {inviteToken ? <InvitePanel token={inviteToken} refresh={refresh} setMessage={setMessage} /> : null}
      {/* Actionable-first ordering: things awaiting a response come before
          things you initiate. Incoming panel renders nothing when empty
          (checked inside), so this position doesn't produce a hollow strip. */}
      <IncomingPanel home={home} refresh={refresh} />
      <PlaySection home={home} refresh={refresh} setMessage={setMessage} />
      <FriendsSection home={home} refresh={refresh} setMessage={setMessage} />
      <GamesSection games={home.games} />
    </div>
  );
}

const INSTALL_DISMISSED_KEY = "chess.install-dismissed";

function InstallPrompt({ home, setMessage }: { home: HomeData; setMessage: SetMessage }) {
  const [pushStatus, setPushStatus] = useState<PushStatus>("checking");
  const [installed, setInstalled] = useState<boolean>(() => detectInstalled());
  // Persist dismissal in localStorage so it sticks across reloads for this
  // browser. Cleared naturally when the user installs (dismissal becomes
  // moot — showInstall is already false) or manually via storage clear.
  const [installDismissed, setInstallDismissed] = useState<boolean>(() => {
    try { return window.localStorage.getItem(INSTALL_DISMISSED_KEY) === "true"; } catch { return false; }
  });

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
      setMessage(error instanceof Error ? error.message : "Notification setup failed.", "error");
    }
  }

  // Install guidance and notification enablement are independent. Show
  // install guidance whenever the app isn't launched from the Home Screen
  // AND the user hasn't dismissed it (dismissal persists in localStorage
  // per Tejas's iPhone-test order — "cannot dismiss it and it drives him
  // nuts").
  const showInstall = !installed && !installDismissed;
  const showEnablePush = pushStatus === "ready";
  const showBlocked = pushStatus === "blocked";
  const showEnabled = pushStatus === "enabled";

  function dismissInstall() {
    try { window.localStorage.setItem(INSTALL_DISMISSED_KEY, "true"); } catch { /* private-mode → session-only dismissal is fine */ }
    setInstallDismissed(true);
  }

  if (!showInstall && !showEnablePush && !showBlocked) return null;

  return (
    <div className="install-strip">
      {showInstall ? (
        <div className="install-block">
          <button
            className="install-dismiss"
            aria-label="Dismiss install prompt"
            onClick={dismissInstall}
            type="button"
          >
            ×
          </button>
          <p className="install-title">Install to your Home Screen</p>
          <p className="install-body">
            Install to get notified — game invites and scheduled games reach you as notifications.
          </p>
          <p className="install-body install-how">
            iPhone: Share → Add to Home Screen. Android/Chrome: menu → Install app.
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
  setMessage: SetMessage;
}) {
  async function send() {
    try {
      await api("/api/friends/invite", { method: "POST", body: JSON.stringify({ token }) });
      setMessage("Friend request sent from invite link.");
      navigate("/", refresh);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invite failed.", "error");
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
  setMessage: SetMessage;
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
      setMessage(error instanceof Error ? error.message : "Challenge failed.", "error");
    }
  }

  async function propose() {
    try {
      const startAt = Date.now() + Math.max(0.02, Number(minutes)) * 60 * 1000;
      await api("/api/schedules", { method: "POST", body: JSON.stringify({ friendId, timeControl, startAt }) });
      setMessage("Game time proposed.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule failed.", "error");
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
  setMessage: SetMessage;
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
      setMessage(error instanceof Error ? error.message : "Friend request failed.", "error");
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
              {/* Plain colored dot only — green for online, hollow gray for
                  offline. The word carried no information the dot doesn't.
                  State exposed via aria-label + status class only. */}
              <span
                className={`presence ${friend.online ? "online" : "offline"}`}
                role="status"
                aria-label={friend.online ? "online" : "offline"}
              />
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
  message,
  messageKind,
  onHome,
  setMessage,
}: {
  gameId: string;
  home: HomeData;
  message: string;
  messageKind: ToastKind;
  onHome: () => void;
  setMessage: SetMessage;
}) {
  const [game, setGame] = useState<GameState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selected, setSelected] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
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

  async function submitMove(from: Square, to: Square, promotion?: "q" | "r" | "b" | "n") {
    try {
      const next = await api<GameState>(`/api/games/${gameId}/move`, {
        method: "POST",
        body: JSON.stringify({ from, to, promotion: promotion || undefined }),
      });
      setGame(next);
      setSelected(null);
      setPendingPromotion(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Move failed.", "error");
      setSelected(null);
      setPendingPromotion(null);
    }
  }

  async function choose(square: Square) {
    if (!game || game.status !== "active") return;
    if (!selected) {
      // Only YOUR OWN pieces are selectable — empty squares and opponent
      // pieces are silent no-ops (no selection state, no legal-move dots
      // for opponent's pieces, no doomed move request, no error toast).
      // Tapping an opponent piece to "see what it could do" is a chess.com
      // affordance the anti-chess.com thesis explicitly rejects.
      const chess = new Chess(game.fen);
      const piece = chess.get(square);
      if (!piece || piece.color !== myColor) return;
      setSelected(square);
      return;
    }
    if (selected === square) {
      // Tapping the selected square again cancels the selection.
      setSelected(null);
      return;
    }
    // Detect promotion locally so we can show the picker instead of
    // silently auto-queening. A pawn moving to rank 8 (white) or rank
    // 1 (black) needs a promotion choice.
    const chess = new Chess(game.fen);
    const piece = chess.get(selected);
    const targetRank = square[1];
    if (piece && piece.type === "p" && ((piece.color === "w" && targetRank === "8") || (piece.color === "b" && targetRank === "1"))) {
      // Verify it's actually a legal promotion target (not a wild tap).
      const legal = chess.moves({ square: selected, verbose: true }) as Array<{ to: string; promotion?: string }>;
      if (legal.some((m) => m.to === square && m.promotion)) {
        setPendingPromotion({ from: selected, to: square });
        return;
      }
    }
    await submitMove(selected, square);
  }

  async function resign() {
    const next = await api<GameState>(`/api/games/${gameId}/resign`, { method: "POST", body: "{}" });
    setGame(next);
    setConfirmResign(false);
  }

  if (loadError) {
    return (
      <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}>
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
  if (!game) return <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}><LoadingLine /></Shell>;

  const opponentHandle = myColor === "w" ? game.blackHandle : game.whiteHandle;
  const myHandle = myColor === "w" ? game.whiteHandle : game.blackHandle;
  const opponentColor: "w" | "b" = myColor === "w" ? "b" : "w";
  const opponentClock = liveClock(game, opponentColor, now);
  const myClock = liveClock(game, myColor, now);
  const opponentPresence = presenceLabel(opponentRawState, opponentHandle);
  const lastMove = game.moves.length ? { from: game.moves[game.moves.length - 1].from, to: game.moves[game.moves.length - 1].to } : null;

  return (
    <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}>
      <section className="game">
        <div className="board-column">
          {/* active-turn class paints the strip vermillion — the whole strip
              IS the turn indicator (Rodchenko: your seat is your color). */}
          <div
            className={`clock-strip top ${game.status === "active" && game.turn === opponentColor ? "active-turn" : ""}`}
          >
            <div className="who">
              {/* Dot before the handle — presence is a state marker on the
                  opponent, not a caption after their name. Same aria contract
                  as the friend row: role=status + aria-label; no visible word. */}
              <span
                className={`presence ${opponentRawState}`}
                role="status"
                aria-label={opponentPresence}
              />
              <span className="handle-line">@{opponentHandle}</span>
            </div>
            <time className="clock">{formatClock(opponentClock)}</time>
          </div>

          <CapturedStrip moves={game.moves} color={opponentColor} />

          <div className="board-holder">
            <Board
              fen={game.fen}
              orientation={myColor || "w"}
              selected={selected}
              onSquare={choose}
              lastMove={lastMove}
            />
          </div>

          <CapturedStrip moves={game.moves} color={myColor} />

          <div
            className={`clock-strip bottom ${game.status === "active" && game.turn === myColor ? "active-turn" : ""}`}
          >
            <div className="who">
              <span className="handle-line">@{myHandle}</span>
              {/* "you" preserved for a11y — visually clipped via CSS.
                  The vermillion strip is what a human reads. */}
              <span className="you">you</span>
            </div>
            <time className="clock">{formatClock(myClock)}</time>
          </div>
        </div>

        {pendingPromotion ? (
          <PromotionPicker
            color={myColor || "w"}
            onPick={(piece) => void submitMove(pendingPromotion.from, pendingPromotion.to, piece)}
            onCancel={() => setPendingPromotion(null)}
          />
        ) : null}

        <aside className="game-side">
          <div className="game-status">
            {game.status === "active" ? (
              /* Turn indicator is visually communicated by the vermillion
                 strip on the active player's clock band (Rodchenko chair
                 duality). This span carries the same signal for screen
                 readers and for the adversity suite's turn-advance probe. */
              <span className="sr-only">{game.turn === myColor ? "Your move" : "Their move"}</span>
            ) : (
              <span className="terminal">
                {game.status}
                {game.result ? ` · ${game.result}` : ""}
              </span>
            )}
          </div>

          <div className="game-actions">
            <button className="link" onClick={onHome}>Home</button>
            {confirmResign ? (
              <>
                <button className="danger" onClick={() => void resign()} disabled={game.status !== "active"}>
                  Confirm resign
                </button>
                <button className="link" onClick={() => setConfirmResign(false)}>Cancel</button>
              </>
            ) : (
              <button className="link warn" onClick={() => setConfirmResign(true)} disabled={game.status !== "active"}>
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
  lastMove,
}: {
  fen: string;
  orientation: "w" | "b";
  selected: Square | null;
  onSquare: (square: Square) => void;
  interactive?: boolean;
  lastMove?: { from: string; to: string } | null;
}) {
  const chess = useMemo(() => new Chess(fen), [fen]);
  const board = chess.board();
  const rankList = orientation === "w" ? ranks : [...ranks].reverse();
  const fileList = orientation === "w" ? files : [...files].reverse();

  // Legal destinations for the currently-selected piece — pulled from
  // chess.js so promotion, castling, and en passant are all included.
  const legalTargets = useMemo(() => {
    if (!selected || !interactive) return new Map<string, "move" | "capture">();
    const moves = chess.moves({ square: selected, verbose: true }) as Array<{ to: string; captured?: string; flags: string }>;
    const map = new Map<string, "move" | "capture">();
    for (const m of moves) {
      map.set(m.to, m.captured || m.flags.includes("e") ? "capture" : "move");
    }
    return map;
  }, [chess, selected, interactive]);

  // King-in-check square gets a vermillion glow. chess.js reports the
  // side to move as in check when inCheck() is true.
  const checkedKingSquare = useMemo(() => {
    if (!interactive) return null;
    if (!chess.inCheck()) return null;
    const turn = chess.turn();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board[r][f];
        if (cell && cell.type === "k" && cell.color === turn) {
          return `${files[f]}${8 - r}`;
        }
      }
    }
    return null;
  }, [chess, board, interactive]);

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
          const target = legalTargets.get(square);
          const isFromLast = lastMove?.from === square;
          const isToLast = lastMove?.to === square;
          const isCheck = checkedKingSquare === square;

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
          const classes = [
            "square",
            dark ? "dark" : "light",
            selected === square ? "selected" : "",
            isFromLast ? "last-from" : "",
            isToLast ? "last-to" : "",
            isCheck ? "in-check" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              className={classes}
              data-square={square}
              key={square}
              onClick={() => void onSquare(square)}
              aria-label={square}
            >
              {showRank ? <span className="coord coord-rank" aria-hidden="true">{rank}</span> : null}
              {showFile ? <span className="coord coord-file" aria-hidden="true">{file}</span> : null}
              {piece ? <PieceGlyph color={piece.color} type={piece.type} /> : null}
              {target === "move" ? <span className="legal-dot" aria-hidden="true" /> : null}
              {target === "capture" ? <span className="legal-capture" aria-hidden="true" /> : null}
            </button>
          );
        }),
      )}
    </div>
  );
}

// Promotion picker — a small celluloid strip that appears when a pawn
// reaches the last rank. Four pins, one per promotion piece; user taps
// the piece to promote. Kills the auto-queen behavior.
function PromotionPicker({
  color,
  onPick,
  onCancel,
}: {
  color: "w" | "b";
  onPick: (piece: "q" | "r" | "b" | "n") => void;
  onCancel: () => void;
}) {
  return (
    <div className="promotion-backdrop" onClick={onCancel} role="dialog" aria-label="Choose promotion piece">
      <div className="promotion-strip" onClick={(e) => e.stopPropagation()}>
        {(["q", "r", "b", "n"] as const).map((t) => (
          <button
            className="promotion-choice"
            key={t}
            onClick={() => onPick(t)}
            aria-label={pieceNames[t]}
          >
            <PieceGlyph color={color} type={t} />
          </button>
        ))}
      </div>
    </div>
  );
}

// Captured-material strip — shows pieces the opponent has taken from
// this player. Displayed above the opponent's clock so the imbalance
// is immediately readable.
function CapturedStrip({ moves, color }: { moves: GameState["moves"]; color: "w" | "b" }) {
  // Rebuild captures by replaying the SAN moves through chess.js.
  const captured = useMemo(() => {
    const c = new Chess();
    const takenFromColor: string[] = [];
    for (const m of moves) {
      const result = c.move(m.san);
      if (result?.captured) {
        // The captured piece belonged to whoever's turn it just was —
        // the side that just made the move captured the OTHER color.
        const capturedColor: "w" | "b" = result.color === "w" ? "b" : "w";
        if (capturedColor === color) takenFromColor.push(result.captured);
      }
    }
    // Sort by piece value so the visual reads left-to-right in strength.
    const rank: Record<string, number> = { q: 5, r: 4, b: 3, n: 2, p: 1 };
    return takenFromColor.sort((a, b) => (rank[b] || 0) - (rank[a] || 0));
  }, [moves, color]);
  // Always render the wrapper so its height is reserved from the very
  // first frame — Tejas reported the whole game screen jumping when the
  // first capture appeared. The wrapper's min-height (see .captured-strip
  // in styles.css) locks the row height whether captured is empty or full.
  return (
    <div className="captured-strip" aria-label={`${color === "w" ? "White" : "Black"} pieces captured`}>
      {captured.map((t, i) => (
        <span className={`captured piece piece-${color}`} key={i}>{color === "w" ? whiteGlyphs[t as never] : blackGlyphs[t as never]}</span>
      ))}
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
  // Always the filled shape — CSS tints piece-w bone and piece-b ink.
  const glyph = filledGlyphs[type];
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
