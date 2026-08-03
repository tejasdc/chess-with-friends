import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import "./styles.css";

// Standard starting position — the auth screen shows a real board in
// this position (the OBJECT arrives before any framing text does, per
// Rodchenko: the furniture IS the invitation to play).
const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Sandbox board — the landing interaction. Real chess.js legality (both
// colors playable, no goal, no scoring), quiet reset to the initial
// position after ~20 seconds of idle. Encapsulated as its own component
// so a rejection is a one-commit removal (swap this back to a static
// <Board interactive={false} />).
function SandboxBoard() {
  const [fen, setFen] = useState(INITIAL_FEN);
  const [selected, setSelected] = useState<Square | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const idleTimer = React.useRef<number | null>(null);

  const IDLE_RESET_MS = 20_000;

  function bumpIdleTimer() {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      setFen(INITIAL_FEN);
      setSelected(null);
      setLastMove(null);
    }, IDLE_RESET_MS);
  }

  useEffect(() => {
    bumpIdleTimer();
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choose(square: Square) {
    const chess = new Chess(fen);
    const piece = chess.get(square);
    // No color-to-move gating — both sides are playable so a tap on any
    // own-color piece works. But the tapped piece MUST match chess.turn()
    // for chess.js to accept the move. Cheat by rewriting whose turn it
    // is when the user selects a piece of the other color first.
    if (!selected) {
      if (!piece) return;
      // If this piece isn't the side-to-move, flip the FEN's turn flag
      // so chess.js will accept moves from either color. Silent.
      if (piece.color !== chess.turn()) {
        const flipped = fen.replace(/ (w|b) /, ` ${piece.color} `);
        setFen(flipped);
      }
      setSelected(square);
      bumpIdleTimer();
      return;
    }
    if (selected === square) {
      setSelected(null);
      bumpIdleTimer();
      return;
    }
    // Attempt move via chess.js. If illegal, silently discard selection.
    try {
      const move = chess.move({ from: selected, to: square, promotion: "q" });
      if (!move) {
        setSelected(null);
        return;
      }
      setFen(chess.fen());
      setLastMove({ from: move.from, to: move.to });
      setSelected(null);
      bumpIdleTimer();
    } catch {
      setSelected(null);
    }
  }

  return (
    <Board
      fen={fen}
      orientation="w"
      selected={selected}
      onSquare={choose}
      interactive={true}
      lastMove={lastMove}
    />
  );
}

type TimeControl = "10|0" | "5|0";
type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";

// Pipe notation stays code-only — humans read minutes. Every surface that
// renders a TimeControl to the user MUST call this. Sweep script in CI
// checks the compiled bundle for "10|0"/"5|0" appearing in user-visible
// contexts.
function formatTimeControl(tc: TimeControl): string {
  return tc === "5|0" ? "5 min" : "10 min";
}
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
  const waitingMatch = path.match(/^\/waiting\/([^/]+)/);

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

  const isInspirations = path === "/inspirations";

  if (loading) return <Shell onSignedOut={() => setHome(null)}><LoadingLine /></Shell>;
  // /inspirations is reachable authenticated OR not — attribution has no
  // gating. Renders inside a Shell (with topbar + ⋯) for consistency.
  if (isInspirations) {
    return (
      <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage} onSignedOut={() => setHome(null)}>
        <InspirationsPage />
      </Shell>
    );
  }
  if (!home) return <AuthScreen onSignedIn={refresh} message={message} messageKind={messageKind} setMessage={setMessage} />;
  if (gameMatch) return <GameScreen gameId={gameMatch[1]} home={home} message={message} messageKind={messageKind} setMessage={setMessage} onHome={() => navigate("/", refresh)} />;
  if (waitingMatch) return <WaitingRoom challengeId={waitingMatch[1]} home={home} message={message} messageKind={messageKind} setMessage={setMessage} onHome={() => navigate("/", refresh)} />;

  return (
    <Shell
      home={home}
      message={message}
      messageKind={messageKind}
      setMessage={setMessage}
      onSignedOut={() => setHome(null)}
      menuExtras={dashboardMenuExtras(home, setMessage)}
    >
      <Dashboard home={home} inviteToken={inviteMatch?.[1]} refresh={refresh} setMessage={setMessage} />
    </Shell>
  );
}

// Copy invite link — moved from dashboard furniture to the ⋯ menu. It's
// an occasional action; every friend already has a "reach me" surface
// via the friends list itself.
function dashboardMenuExtras(home: HomeData, setMessage: SetMessage) {
  const invite = `${window.location.origin}${home.inviteUrl}`;
  return (closeMenu: () => void) => (
    <li>
      <button
        className="menu-item"
        onClick={async () => {
          closeMenu();
          try {
            await navigator.clipboard.writeText(invite);
            setMessage("Invite link copied.");
          } catch {
            // Clipboard permission blocked — fall back to a toast with
            // the link so the user can select-and-copy manually.
            setMessage(invite);
          }
        }}
      >
        Copy invite link
      </button>
    </li>
  );
}

function Shell({
  children,
  home,
  message,
  messageKind,
  setMessage,
  onSignedOut,
  menuExtras,
  hideMenu,
}: {
  children?: React.ReactNode;
  home?: HomeData | null;
  message?: string;
  messageKind?: ToastKind;
  setMessage?: SetMessage;
  onSignedOut?: () => void;
  /* Optional menu items to inject above the universal Sign out / state /
     Inspirations items. Used by GameScreen to expose Home + Resign inside
     the same ⋯ menu (team-lead: one menu pattern, one position). */
  menuExtras?: (closeMenu: () => void) => React.ReactNode;
  /* Landing screen suppresses chrome — signed-out visitors need no menu.
     The footer carries attribution + the one useful link (inspirations). */
  hideMenu?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Close menu when route changes.
  const path = usePathname();
  useEffect(() => { setMenuOpen(false); }, [path]);
  // Close on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <main className="shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate("/")}>Chess with friends</button>
        <div className="topbar-right">
          {home ? <span className="handle">@{home.user.handle}</span> : null}
          {/* Universal ⋯ menu — top-right on every screen per team-lead.
              Kept as one pattern so users learn "menu lives here" once.
              Landing suppresses it via hideMenu — signed-out visitors
              need no chrome; the footer carries the one useful link. */}
          {hideMenu ? null : (
            <button
              className="menu-dot"
              type="button"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(v => !v)}
            >···</button>
          )}
        </div>
      </header>
      {menuOpen && !hideMenu ? (
        <MenuSheet
          home={home || null}
          onClose={() => setMenuOpen(false)}
          onSignedOut={onSignedOut}
          extras={menuExtras}
        />
      ) : null}
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

// Bottom sheet menu — one pattern, one position (⋯ top-right on every
// screen). Lists Sign out, install state, notification state, Inspirations.
function MenuSheet({
  home,
  onClose,
  onSignedOut,
  extras,
}: {
  home: HomeData | null;
  onClose: () => void;
  onSignedOut?: () => void;
  extras?: (closeMenu: () => void) => React.ReactNode;
}) {
  const [notifState, setNotifState] = useState<"unknown" | "granted" | "denied" | "default" | "unsupported">("unknown");
  const [installed, setInstalled] = useState<boolean>(() => detectInstalled());
  useEffect(() => {
    if (!("Notification" in window)) { setNotifState("unsupported"); return; }
    setNotifState(Notification.permission as "granted" | "denied" | "default");
    const media = window.matchMedia("(display-mode: standalone)");
    const update = () => setInstalled(detectInstalled());
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="menu-sheet" role="dialog" aria-label="App menu">
        <ul className="menu-list">
          {extras ? extras(onClose) : null}
          {home ? (
            <li>
              <button className="menu-item" onClick={() => { onClose(); void signOut(onSignedOut || (() => undefined)); }}>
                Sign out
              </button>
            </li>
          ) : null}
          <li>
            <div className="menu-state">
              <span className="menu-state-label">Installed</span>
              <span className="menu-state-value">{installed ? "yes" : "not yet"}</span>
            </div>
          </li>
          <li>
            <div className="menu-state">
              <span className="menu-state-label">Notifications</span>
              <span className="menu-state-value">
                {notifState === "granted" ? "on"
                  : notifState === "denied" ? "blocked"
                  : notifState === "unsupported" ? "unsupported"
                  : "not yet"}
              </span>
            </div>
          </li>
          <li>
            <button
              className="menu-item"
              onClick={() => { onClose(); navigate("/inspirations"); }}
            >
              Inspirations
            </button>
          </li>
        </ul>
      </div>
    </>
  );
}

// Attribution page — Rodchenko / Hartwig / Villalba + palette credit.
// Simple in-world layout; back link at top; ⋯ menu still available in
// the Shell topbar for consistency.
function InspirationsPage() {
  // Same no-scroll shell as landing/game — Tejas's general law now that
  // nothing on this page NEEDS to scroll.
  useEffect(() => {
    document.body.dataset.screen = "inspirations";
    return () => {
      if (document.body.dataset.screen === "inspirations") delete document.body.dataset.screen;
    };
  }, []);
  return (
    <div className="inspirations">
      <button className="link" onClick={() => navigate("/")}>← back</button>
      <h1 className="insp-title">Inspirations</h1>
      <p className="insp-body">
        Leisure reconceived as active and collective, not passive and solitary.
      </p>
      <ul className="insp-list">
        <li><strong>Alexander Rodchenko</strong> · Chess table for the workers' club, 1925.</li>
        <li><strong>Virgilio Villalba</strong> · Untitled, 1955.</li>
      </ul>
      <MadeByTejas />
    </div>
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

  // Landing borrows the no-scroll shell — everything must fit in one
  // viewport at 390, footer pinned to the bottom. Tejas's general law:
  // "if you don't need scrolling, let's not add scrolling."
  useEffect(() => {
    document.body.dataset.screen = "landing";
    return () => {
      if (document.body.dataset.screen === "landing") delete document.body.dataset.screen;
    };
  }, []);

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
      // Explicit terminal-error matrix (team-lead's verbatim phrases).
      // Reverses the earlier silence-on-cancel policy: user-dismissal is
      // rare, so on failure default to the truthful interpretation and
      // say it immediately. Never the platform's own words.
      const name = error instanceof Error ? error.name : "";
      const msg = error instanceof Error ? error.message : "";
      const isNotAllowed = name === "NotAllowedError"
        || /not allowed by the user agent|cancel|timeout|no.*credential/i.test(msg);
      const isPlatform = error instanceof DOMException
        || /^(Not|Invalid|Security|Timeout|Constraint|Abort|Unknown)[A-Z][A-Za-z]*Error$/.test(name)
        || /\bDOMException\b/i.test(msg);

      if (decided === "register") {
        // Sign-up flow terminals:
        if (isNotAllowed) {
          setMessage("Passkey wasn't created — try again.", "error");
        } else if (isPlatform) {
          setMessage("Couldn't create a passkey on this device.", "error");
        } else {
          // Server error — includes "That handle is already taken."
          // race when two clients register the same handle at once.
          setMessage(msg || "Sign up failed.", "error");
        }
      } else {
        // Sign-in flow terminals — cancel / no-credential is guidance,
        // not failure ("info" tint per team-lead — it reads calmer than
        // vermillion and matches the "handle may be taken" intent).
        if (isNotAllowed || isPlatform) {
          setMessage("That handle may be taken — try a different one.", "info");
        } else {
          setMessage(msg || "Sign in failed.", "error");
        }
      }
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
    <Shell message={message} messageKind={messageKind} setMessage={setMessage} hideMenu>
      <section className="auth">
        <div className="auth-scene">
          {/* Sandbox — real legal moves, no goal, resets after 20s idle.
              Feels like a real set to touch, not a puzzle. */}
          <SandboxBoard />
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
        <LandingFooter />
      </section>
    </Shell>
  );
}

// Landing footer — pinned to the bottom of the viewport. Both attribution
// and the one useful signed-out link (inspirations) in one quiet line.
function LandingFooter() {
  return (
    <p className="made-by landing-footer">
      made by{" "}
      <a href="https://tejas.nyc" target="_blank" rel="noreferrer">tejas.nyc</a>
      {" · "}
      <button className="linkish" type="button" onClick={() => navigate("/inspirations")}>inspirations</button>
    </p>
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
      {/* Ordering: (1) INCOMING actions the user must respond to, (2) games
          already IN PLAY — an accepted invite must not require scrolling
          past a Play form to find, (3) PLAY to start something new,
          (4) friends list, (5) PAST games collapsed. Passive material
          sinks; the user's current obligations rise. */}
      <IncomingPanel home={home} refresh={refresh} />
      <LiveGamesSection games={home.games} />
      {/* PlaySection (Schedule) now lives INSIDE FriendsSection as a
          bottom-of-list button — Tejas's decision. Kept as its own
          component so the schedule form logic is unchanged. */}
      <FriendsSection home={home} refresh={refresh} setMessage={setMessage} />
      <PastGamesSection games={home.games} />
      <MadeByTejas />
    </div>
  );
}

// "made by tejas.nyc" — quiet attribution line. Landing (auth), Dashboard,
// and /inspirations only. NEVER on the game screen — the game stays pure.
// Style follows Tejas's own site convention: small, mono, muted, one line.
function MadeByTejas() {
  return (
    <p className="made-by">
      made by{" "}
      <a href="https://tejas.nyc" target="_blank" rel="noreferrer">tejas.nyc</a>
    </p>
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
        <div className="notif-block">
          <button className="ghost" onClick={enablePush}>Enable notifications</button>
          <p className="install-body notif-reason">so you know when a friend invites you</p>
        </div>
      ) : null}
      {showBlocked && !showInstall ? (
        <div className="notif-block">
          <p className="install-title">Notifications are off</p>
          {/* Tejas's simplified recovery: reinstall resets iOS permission
              state entirely, and the passkey makes re-login trivial. One
              instruction, the easy one — no Settings-path spelunking. */}
          <p className="install-body">
            Delete the app from your Home Screen and add it back — you'll be asked again.
          </p>
        </div>
      ) : null}
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
      label: <><strong>@{challenge.fromHandle}</strong> invited you to a game · {formatTimeControl(challenge.timeControl)}</>,
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
            {formatTimeControl(schedule.timeControl)}
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

// Split into two: LIVE games shout at the top of the dashboard so an
// accepted invitation is unmissable; past games get their own collapsed
// section far below. Never mixed — mixing them buries the one thing the
// user was told about into the noise of games they already know about.
function LiveGamesSection({ games }: { games: GameMeta[] }) {
  const active = games.filter((game) => game.status === "active");
  if (!active.length) return null;
  return (
    <section className="games games-live">
      <h2 className="section-title">In play</h2>
      <div className="game-rows">
        {active.map((game) => (
          <GameRow key={game.id} game={game} accent />
        ))}
      </div>
    </section>
  );
}

function PastGamesSection({ games }: { games: GameMeta[] }) {
  const past = games.filter((game) => game.status !== "active");
  const [open, setOpen] = useState(false);
  if (!past.length) return null;
  return (
    <section className="games games-past">
      <button
        className="section-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="section-title">Past games</span>
        <span className="section-toggle-count">{past.length}</span>
        <span className="section-toggle-caret" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="game-rows">
          {past.slice(0, 20).map((game) => (
            <GameRow key={game.id} game={game} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function GameRow({ game, accent }: { game: GameMeta; accent?: boolean }) {
  const status = game.status === "active" ? "in play" : game.result || game.status;
  return (
    <button className={`game-row ${accent ? "accent" : ""}`} onClick={() => navigate(`/game/${game.id}`)}>
      <span className="row-mono">{formatTimeControl(game.timeControl)}</span>
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
  // "Play now" is a per-friend row action on the Friends list — Play here
  // is now ONLY the "propose a time" surface. Kept as a compact form
  // because "day + time" needs two inputs; hidden by default behind a
  // Schedule toggle so it doesn't fight for space with the friends list.
  const [friendId, setFriendId] = useState(home.friends[0]?.id || "");
  const [day, setDay] = useState<string>(() => defaultDayValue());
  const [time, setTime] = useState<string>("19:00");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!friendId && home.friends[0]) setFriendId(home.friends[0].id);
  }, [friendId, home.friends]);

  async function propose() {
    try {
      const startAt = dayTimeToMillis(day, time);
      if (!Number.isFinite(startAt)) throw new Error("Pick a valid day and time.");
      // TIME CONTROL is hardcoded — 10 min IS the game. Server type still
      // accepts the union for future flexibility; UI never asks.
      await api("/api/schedules", { method: "POST", body: JSON.stringify({ friendId, timeControl: "10|0", startAt }) });
      setMessage("Game time proposed.");
      setOpen(false);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule failed.", "error");
    }
  }

  const outgoingSchedules = home.schedules.filter(
    (schedule) => schedule.fromId === home.user.id || (schedule.toId === home.user.id && schedule.status !== "pending"),
  );

  if (home.friends.length === 0 && outgoingSchedules.length === 0) return null;

  return (
    <section className="play">
      <button
        type="button"
        className="section-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={home.friends.length === 0}
      >
        <span className="section-title">Schedule a game</span>
        <span className="section-toggle-caret" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      {open && home.friends.length > 0 ? (
        <div className="play-form">
          <label className="field">
            <span className="field-label">Friend</span>
            <FriendSelect friends={home.friends} value={friendId} onChange={setFriendId} />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field-label">Day</span>
              <select value={day} onChange={(event) => setDay(event.target.value)}>
                {dayOptions().map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Time</span>
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
          </div>
          <div className="play-action">
            <button className="primary" onClick={propose} disabled={!friendId}>Propose</button>
          </div>
        </div>
      ) : null}

      {outgoingSchedules.length ? (
        <ul className="pending">
          {outgoingSchedules.map((schedule) => (
            <li key={schedule.id}>
              @{schedule.fromHandle} → @{schedule.toHandle}{" "}
              · {formatScheduleWhen(schedule.startAt)}{" "}
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

// Day picker options: today, tomorrow, then each of the next five
// named weekdays (Tue, Wed, ..., Sun). Encodes the friction Tejas wanted
// — "a real day + time, not minutes from now." A future round adds
// recurrence (every Tuesday 9pm); the schedule shape already allows an
// optional `recurrence` field on the server side (documented invariant,
// not yet populated), so recurring can layer on without a data change.
function dayOptions(): Array<{ value: string; label: string }> {
  const now = new Date();
  const out: Array<{ value: string; label: string }> = [];
  const iso = (offset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  };
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  out.push({ value: iso(0), label: "Today" });
  out.push({ value: iso(1), label: "Tomorrow" });
  for (let i = 2; i <= 6; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    out.push({ value: iso(i), label: weekday[d.getDay()] });
  }
  return out;
}
function defaultDayValue(): string { return dayOptions()[0].value; }
function dayTimeToMillis(day: string, time: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const d = new Date();
  d.setFullYear(year, month - 1, date);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}
function formatScheduleWhen(startAt: number): string {
  const d = new Date(startAt);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const dayLabel = sameDay ? "Today" : isTomorrow ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const timeLabel = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${dayLabel} · ${timeLabel}`;
}

// Friends list IS the action surface (Tejas's simplification directive):
// no dropdown, no separate Send form. Each friend row has an Invite
// button. Online friends sort first and their button is enabled — the
// button's presence IS the presence signal, with the dot as a second
// cue. Offline rows still list the handle so you know they exist, but
// the button is disabled — you can't play a friend who isn't around.
//
// Scale guard: show N rows (INITIAL_VISIBLE), rest behind a "more
// friends" disclosure — designed for hundreds without dashboard spam.
const INITIAL_VISIBLE_FRIENDS = 8;

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
  const [showAll, setShowAll] = useState(false);

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

  async function invite(friend: Friend) {
    try {
      const { challenge } = await api<{ challenge: { id: string } }>("/api/challenges", {
        method: "POST",
        // 10 min is the game — no choice to render, no choice to make.
        body: JSON.stringify({ friendId: friend.id, timeControl: "10|0" }),
      });
      navigate(`/waiting/${challenge.id}`, refresh);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invite failed.", "error");
    }
  }

  // Online first, then offline; each group alphabetized so the order
  // stays stable across refreshes.
  const sortedFriends = [...home.friends].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.handle.localeCompare(b.handle);
  });
  const visibleFriends = showAll ? sortedFriends : sortedFriends.slice(0, INITIAL_VISIBLE_FRIENDS);
  const hiddenCount = sortedFriends.length - visibleFriends.length;

  return (
    <section className="friends">
      <h2 className="section-title">Friends</h2>

      {home.sentRequests.length ? (
        <ul className="pending">
          {home.sentRequests.map((request) => (
            <li key={request.id}>Request sent to @{request.toHandle}</li>
          ))}
        </ul>
      ) : null}

      {home.friends.length ? (
        <>
          <ul className="friend-list">
            {visibleFriends.map((friend) => (
              <li className="friend-card" key={friend.id}>
                <span
                  className={`presence ${friend.online ? "online" : "offline"}`}
                  role="status"
                  aria-label={friend.online ? "online" : "offline"}
                />
                <span className="friend-handle">@{friend.handle}</span>
                <button
                  className="primary compact friend-invite"
                  onClick={() => void invite(friend)}
                  disabled={!friend.online}
                  aria-label={friend.online ? `Invite @${friend.handle}` : `@${friend.handle} is offline`}
                >
                  {friend.online ? "Invite" : "Offline"}
                </button>
              </li>
            ))}
          </ul>
          {hiddenCount > 0 && !showAll ? (
            <button className="ghost more-friends" onClick={() => setShowAll(true)}>
              More friends ({hiddenCount})
            </button>
          ) : null}
        </>
      ) : (
        <p className="muted">No friends yet. Add one below, or share your invite link from the ⋯ menu.</p>
      )}

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

      {/* Schedule entry point — one button at the BOTTOM of the friends
          section (Tejas's decision). Tapping expands the day + time
          picker. Visible enough to be discovered, out of the way when
          the user isn't scheduling. */}
      <PlaySection home={home} refresh={refresh} setMessage={setMessage} />
    </section>
  );
}

// Waiting room — the sender lands here IMMEDIATELY after sending a
// challenge. Full board visible, opponent bar reads "waiting for @x".
// The point of the flow (Tejas's directive): inviting means sitting
// down. Polls the challenge state every 2s and transitions to the live
// game in-place when the invitee accepts; if the invitee accepts while
// the sender walked away, the challenge_accepted push brings them back.
function WaitingRoom({
  challengeId,
  home,
  message,
  messageKind,
  onHome,
  setMessage,
}: {
  challengeId: string;
  home: HomeData;
  message: string;
  messageKind: ToastKind;
  onHome: () => void;
  setMessage: SetMessage;
}) {
  const [challenge, setChallenge] = useState<Challenge & { gameId?: string; status?: string; toId?: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Waiting room borrows the game screen's no-scroll shell — same
  // full-viewport board treatment, just with an idle bar.
  useEffect(() => {
    document.body.dataset.screen = "game";
    return () => {
      if (document.body.dataset.screen === "game") delete document.body.dataset.screen;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function poll() {
      try {
        const { challenge: next } = await api<{ challenge: Challenge & { gameId?: string; status?: string; toId?: string } }>(`/api/challenges/${challengeId}/state`);
        if (cancelled) return;
        setChallenge(next);
        setLoadError(null);
        if (next.status === "accepted" && next.gameId) {
          navigate(`/game/${next.gameId}`);
          return;
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Could not check the invite.");
      }
      timer = window.setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [challengeId]);

  const menuExtras = (closeMenu: () => void) => (
    <li>
      <button className="menu-item" onClick={() => { closeMenu(); onHome(); }}>
        Home
      </button>
    </li>
  );

  if (loadError) {
    return (
      <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}>
        <section className="game-error">
          <h2 className="section-title">Can't open this invite</h2>
          <p className="muted">{loadError}</p>
          <div className="game-actions">
            <button className="ghost" onClick={onHome}>Home</button>
          </div>
        </section>
      </Shell>
    );
  }

  if (!challenge) return <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage}><LoadingLine /></Shell>;

  // If we already sent the challenge, the invitee is toHandle from our
  // side. Fall back on the friend list for a handle if the server did
  // not enrich fromHandle/toHandle (it does, but be safe).
  const inviteeHandle = challenge.toHandle
    || home.friends.find((friend) => friend.id === (challenge as unknown as { toId?: string }).toId)?.handle
    || "your friend";
  const invitee = home.friends.find((friend) => friend.handle === inviteeHandle);
  const inviteePresence: string = invitee?.online ? "online" : "offline";

  return (
    <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage} menuExtras={menuExtras}>
      <section className="game game-fixed">
        <div className="board-column">
          <div className="clock-strip top">
            <div className="who">
              <span
                className={`presence ${inviteePresence}`}
                role="status"
                aria-label={inviteePresence}
              />
              <span className="handle-line">waiting for @{inviteeHandle}</span>
            </div>
            <span className="clock waiting-label">{formatTimeControl(challenge.timeControl)}</span>
          </div>

          <div className="board-holder">
            <Board
              fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
              orientation="w"
              selected={null}
              onSquare={() => { /* no-op — no game yet */ }}
              interactive={false}
              lastMove={null}
            />
          </div>

          <div className="clock-strip bottom">
            <div className="who">
              <span className="handle-line">@{home.user.handle}</span>
              <span className="you">you</span>
            </div>
            <span className="clock waiting-label">ready</span>
          </div>
        </div>

        <div className="game-bottom">
          <span className="turn-status">Sit tight — they'll come when they can.</span>
        </div>
      </section>
    </Shell>
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

  // Lock the viewport to no-scroll while on the game screen. Board sizes
  // itself to fit the remaining budget via CSS; no vertical scroll on any
  // form factor. Attribute is namespaced so other routes are unaffected.
  useEffect(() => {
    document.body.dataset.screen = "game";
    return () => {
      if (document.body.dataset.screen === "game") delete document.body.dataset.screen;
    };
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
    // Silent-board principle: during play, the BOARD is the only feedback
    // channel. Gameplay taps NEVER produce toasts. Off-turn or illegal
    // taps are silent no-ops so the server-side "Illegal move." / "It is
    // not your turn." responses are unreachable in the normal UI flow
    // (they still exist as an authoritative backstop).
    if (game.turn !== myColor) {
      // Not your turn. The turn strip already tells you whose it is; a
      // tap on your own piece here is silent — no selection, no dots,
      // no move request. Same silence already applies to opponent
      // pieces (below); extend to own-pieces-off-turn.
      return;
    }
    const chess = new Chess(game.fen);
    const targetPiece = chess.get(square);
    if (!selected) {
      // Only YOUR OWN pieces are selectable — empty squares and opponent
      // pieces are silent no-ops. Tapping an opponent piece to "see what
      // it could do" is a chess.com affordance the anti-chess.com thesis
      // explicitly rejects.
      if (!targetPiece || targetPiece.color !== myColor) return;
      setSelected(square);
      return;
    }
    if (selected === square) {
      // Tapping the selected square again cancels the selection.
      setSelected(null);
      return;
    }
    // Tapping another of your OWN pieces retargets the selection —
    // natural correction path when the user changes their mind.
    if (targetPiece && targetPiece.color === myColor) {
      setSelected(square);
      return;
    }
    // Client-side legality gate — chess.js already computes the same
    // legal-target set the dot overlay uses. If the target isn't in
    // that set, the tap is silent: deselect and stop. No doomed move
    // request, no "Illegal move." toast.
    const legalMoves = chess.moves({ square: selected, verbose: true }) as Array<{ to: string; promotion?: string }>;
    const legalTarget = legalMoves.find((m) => m.to === square);
    if (!legalTarget) {
      setSelected(null);
      return;
    }
    // Detect promotion locally so we show the picker instead of
    // silently auto-queening.
    const fromPiece = chess.get(selected);
    const targetRank = square[1];
    if (fromPiece && fromPiece.type === "p" && ((fromPiece.color === "w" && targetRank === "8") || (fromPiece.color === "b" && targetRank === "1"))) {
      if (legalMoves.some((m) => m.to === square && m.promotion)) {
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

  // Home + Resign live inside the universal ⋯ menu (team-lead: one menu
  // pattern, one position). Rendered via Shell's menuExtras hook so the
  // game screen doesn't need its own bespoke menu chrome.
  const gameMenuExtras = (closeMenu: () => void) => (
    <>
      <li>
        <button className="menu-item" onClick={() => { closeMenu(); onHome(); }}>
          Home
        </button>
      </li>
      {confirmResign ? (
        <>
          <li>
            <button
              className="menu-item menu-item-danger"
              disabled={game.status !== "active"}
              onClick={() => { closeMenu(); void resign(); }}
            >
              Confirm resign
            </button>
          </li>
          <li>
            <button className="menu-item" onClick={() => setConfirmResign(false)}>
              Cancel
            </button>
          </li>
        </>
      ) : (
        <li>
          <button
            className="menu-item menu-item-warn"
            disabled={game.status !== "active"}
            onClick={() => setConfirmResign(true)}
          >
            Resign
          </button>
        </li>
      )}
    </>
  );

  const activeCount = game.moves.length;

  return (
    <Shell home={home} message={message} messageKind={messageKind} setMessage={setMessage} menuExtras={gameMenuExtras}>
      <section className="game game-fixed">
        <div className="board-column">
          {/* active-turn class paints the strip DEEP-INK (Villalba
              incision made large). Cream text on the ink band. */}
          <div
            className={`clock-strip top ${game.status === "active" && game.turn === opponentColor ? "active-turn" : ""}`}
          >
            <div className="who">
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
              {/* No self-presence dot — you're obviously here. Opponent's
                  strip carries the only presence indicator. "you" span
                  preserved for a11y (visually clipped). */}
              <span className="handle-line">@{myHandle}</span>
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

        {/* Slim bottom bar — turn status + move count only, per team-lead.
            Home + Resign live in the ⋯ menu (topbar). */}
        <div className="game-bottom">
          <span className="turn-status">
            {game.status === "active" ? (
              game.turn === myColor ? "Your move" : "Their move"
            ) : (
              <span className="terminal">
                {game.status}
                {game.result ? ` · ${game.result}` : ""}
              </span>
            )}
          </span>
          <span className="move-count">{activeCount} move{activeCount === 1 ? "" : "s"}</span>
        </div>
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
