import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, CalendarClock, Copy, Flag, LogOut, Plus, RefreshCcw, Send, Share2, Sword } from "lucide-react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import "./styles.css";

type TimeControl = "10|0" | "5|0";
type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";
type PushStatus = "checking" | "ready" | "enabled" | "blocked" | "unsupported";

interface Friend {
  id: string;
  handle: string;
  online: boolean;
}

interface FriendRequest {
  id: string;
  fromHandle?: string;
  toHandle?: string;
}

interface Challenge {
  id: string;
  fromHandle?: string;
  toHandle?: string;
  timeControl: TimeControl;
}

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
const pieceNames: Record<PieceSymbol, string> = { p: "padati", n: "ashva", b: "gaja", r: "ratha", q: "mantri", k: "raja" };
const ashtapadaMarks = new Set(["b1", "c1", "f1", "g1", "b4", "c4", "f4", "g4", "b5", "c5", "f5", "g5", "b8", "c8", "f8", "g8"]);

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
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

  if (loading) return <Shell message="Opening board..." />;
  if (!home) return <AuthScreen onSignedIn={refresh} message={message} setMessage={setMessage} />;
  if (gameMatch) return <GameScreen gameId={gameMatch[1]} home={home} onHome={() => navigate("/", refresh)} setMessage={setMessage} />;

  return (
    <Shell home={home} message={message}>
      <div className="dashboard-grid">
        <InstallPanel home={home} setMessage={setMessage} />
        {inviteMatch ? <InvitePanel token={inviteMatch[1]} refresh={refresh} setMessage={setMessage} /> : null}
        <FriendPanel home={home} refresh={refresh} setMessage={setMessage} />
        <ChallengePanel home={home} refresh={refresh} setMessage={setMessage} />
        <SchedulePanel home={home} refresh={refresh} setMessage={setMessage} />
        <GamesPanel home={home} refresh={refresh} />
      </div>
    </Shell>
  );
}

function Shell({ children, home, message }: { children?: React.ReactNode; home?: HomeData | null; message?: string }) {
  return (
    <main className="app-shell">
      <div className="page-ornament" aria-hidden="true" />
      <header className="topbar">
        <button className="brand" onClick={() => navigate("/")}>
          <span className="brand-mark" aria-hidden="true"><ElephantMark /></span>
          <span>Friends-only chess</span>
        </button>
        {home ? (
          <div className="account">
            <span>@{home.user.handle}</span>
            <button className="icon-button" aria-label="Refresh" onClick={() => window.location.reload()}>
              <RefreshCcw size={18} />
            </button>
            <button className="icon-button" aria-label="Sign out" onClick={() => void signOut()}>
              <LogOut size={18} />
            </button>
          </div>
        ) : null}
      </header>
      {message ? <p className="notice" role="status">{message}</p> : null}
      <div className="surface-stack">{children}</div>
    </main>
  );
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

function AuthScreen({ onSignedIn, message, setMessage }: { onSignedIn: () => void; message: string; setMessage: (value: string) => void }) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);

  async function register() {
    setBusy(true);
    try {
      const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>("/api/auth/register/options", {
        method: "POST",
        body: JSON.stringify({ handle }),
      });
      const response = await startRegistration({ optionsJSON });
      await api("/api/auth/register/verify", { method: "POST", body: JSON.stringify({ handle, response }) });
      await onSignedIn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Registration failed.");
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    try {
      const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>("/api/auth/login/options", {
        method: "POST",
        body: JSON.stringify({ handle }),
      });
      const response = await startAuthentication({ optionsJSON });
      await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ handle, response }) });
      await onSignedIn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell message={message}>
      <section className="auth-panel">
        <div className="auth-copy">
          <div className="hero-seal" aria-hidden="true"><ElephantMark /></div>
          <p className="eyebrow">Chaturanga lineage</p>
          <h1>Sit down when your friend is ready.</h1>
          <p className="lede">A quiet board, a known opponent, and no open pool of strangers.</p>
        </div>
        <div className="auth-form">
          <label>
            Handle
            <input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="your_handle" autoComplete="username webauthn" />
          </label>
          <div className="button-row">
            <button onClick={register} disabled={busy || !handle}>Create passkey</button>
            <button className="secondary" onClick={login} disabled={busy || !handle}>Sign in</button>
          </div>
          <p className="small">No email or phone number. Your passkey is the account anchor.</p>
        </div>
      </section>
    </Shell>
  );
}

function InstallPanel({ home, setMessage }: { home: HomeData; setMessage: (value: string) => void }) {
  const [pushStatus, setPushStatus] = useState<PushStatus>("checking");

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

  if (pushStatus === "enabled") return null;

  return (
    <section className="panel install">
      <div>
        <p className="panel-kicker">Three allowed pushes</p>
        <h2>Install & notifications</h2>
        {pushStatus === "blocked" ? (
          <p>Notifications are blocked in this browser. They are only for friend requests, game challenges, and scheduled games starting.</p>
        ) : (
          <p>On iPhone, open Share and choose Add to Home Screen before enabling notifications. Notifications are only for friend requests, game challenges, and scheduled games starting.</p>
        )}
      </div>
      {pushStatus === "ready" ? (
        <button onClick={enablePush}>
          <Bell size={18} />
          Enable notifications
        </button>
      ) : null}
    </section>
  );
}

function InvitePanel({ token, refresh, setMessage }: { token: string; refresh: () => void; setMessage: (value: string) => void }) {
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
    <section className="panel accent-panel invite-panel">
      <p className="panel-kicker">Invite link</p>
      <h2>Join this circle</h2>
      <button onClick={send}>
        <Send size={18} />
        Send friend request
      </button>
    </section>
  );
}

function FriendPanel({ home, refresh, setMessage }: { home: HomeData; refresh: () => void; setMessage: (value: string) => void }) {
  const [handle, setHandle] = useState("");
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

  async function accept(id: string) {
    await api(`/api/friends/${id}/accept`, { method: "POST", body: "{}" });
    await refresh();
  }

  return (
    <section className="panel friend-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">Circle</p>
          <h2>Friends</h2>
        </div>
        <button className="icon-button" aria-label="Copy invite link" onClick={() => void navigator.clipboard.writeText(invite)}>
          <Copy size={18} />
        </button>
      </div>
      <div className="inline-form">
        <label>
          Friend handle
          <input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="friend_handle" />
        </label>
        <button onClick={requestFriend} disabled={!handle}>
          <Plus size={18} />
          Add
        </button>
      </div>
      <p className="small break-all">{invite}</p>
      {home.requests.map((request) => (
        <div className="list-row" key={request.id}>
          <span>@{request.fromHandle} wants to be friends.</span>
          <button onClick={() => void accept(request.id)}>Accept</button>
        </div>
      ))}
      {home.sentRequests.map((request) => (
        <div className="list-row quiet" key={request.id}>Request sent to @{request.toHandle}</div>
      ))}
      <div className="friend-grid">
        {home.friends.map((friend) => (
          <div className="friend-card" key={friend.id}>
            <strong>@{friend.handle}</strong>
            <span className={friend.online ? "online" : "offline"}>{friend.online ? "online" : "offline"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChallengePanel({ home, refresh, setMessage }: { home: HomeData; refresh: () => void; setMessage: (value: string) => void }) {
  const [friendId, setFriendId] = useState(home.friends[0]?.id || "");
  const [timeControl, setTimeControl] = useState<TimeControl>("10|0");

  useEffect(() => {
    if (!friendId && home.friends[0]) setFriendId(home.friends[0].id);
  }, [friendId, home.friends]);

  async function challenge() {
    try {
      await api("/api/challenges", { method: "POST", body: JSON.stringify({ friendId, timeControl }) });
      setMessage("Challenge sent.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Challenge failed.");
    }
  }

  async function accept(id: string) {
    const { game } = await api<{ game: GameMeta }>(`/api/challenges/${id}/accept`, { method: "POST", body: "{}" });
    navigate(`/game/${game.id}`);
  }

  return (
    <section className="panel challenge-panel">
      <p className="panel-kicker">Live board</p>
      <h2>Challenge</h2>
      <div className="inline-form">
        <label>
          Friend
          <FriendSelect friends={home.friends} value={friendId} onChange={setFriendId} />
        </label>
        <label>
          Time control
          <TimeSelect value={timeControl} onChange={setTimeControl} />
        </label>
        <button onClick={challenge} disabled={!friendId}>
          <Sword size={18} />
          Send
        </button>
      </div>
      {home.challenges.map((challenge) => (
        <div className="list-row" key={challenge.id}>
          <span>@{challenge.fromHandle} challenged you to {challenge.timeControl}.</span>
          <button onClick={() => void accept(challenge.id)}>Accept</button>
        </div>
      ))}
      {home.sentChallenges.map((challenge) => (
        <div className="list-row quiet" key={challenge.id}>Challenge sent to @{challenge.toHandle}</div>
      ))}
    </section>
  );
}

function SchedulePanel({ home, refresh, setMessage }: { home: HomeData; refresh: () => void; setMessage: (value: string) => void }) {
  const [friendId, setFriendId] = useState(home.friends[0]?.id || "");
  const [timeControl, setTimeControl] = useState<TimeControl>("10|0");
  const [minutes, setMinutes] = useState("10");

  async function create() {
    try {
      const startAt = Date.now() + Math.max(0.02, Number(minutes)) * 60 * 1000;
      await api("/api/schedules", { method: "POST", body: JSON.stringify({ friendId, timeControl, startAt }) });
      setMessage("Game time proposed.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Schedule failed.");
    }
  }

  async function accept(id: string) {
    await api(`/api/schedules/${id}/accept`, { method: "POST", body: "{}" });
    await refresh();
  }

  return (
    <section className="panel schedule-panel">
      <p className="panel-kicker">Time & place</p>
      <h2>Schedule</h2>
      <div className="inline-form">
        <label>
          Friend
          <FriendSelect friends={home.friends} value={friendId} onChange={setFriendId} />
        </label>
        <label>
          Time control
          <TimeSelect value={timeControl} onChange={setTimeControl} />
        </label>
        <label className="compact-label">
          Start in minutes
          <input value={minutes} onChange={(event) => setMinutes(event.target.value)} inputMode="decimal" />
        </label>
        <button onClick={create} disabled={!friendId}>
          <CalendarClock size={18} />
          Propose
        </button>
      </div>
      {home.schedules.map((schedule) => (
        <div className="list-row" key={schedule.id}>
          <span>
            @{schedule.fromHandle} → @{schedule.toHandle}, {new Date(schedule.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}, {scheduleStatus(schedule.status)}
          </span>
          {schedule.toId === home.user.id && schedule.status === "pending" ? <button onClick={() => void accept(schedule.id)}>Accept</button> : null}
          {schedule.gameId ? <button onClick={() => navigate(`/game/${schedule.gameId}`)}>Open</button> : null}
        </div>
      ))}
    </section>
  );
}

function GamesPanel({ home, refresh }: { home: HomeData; refresh: () => void }) {
  return (
    <section className="panel games-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">Board table</p>
          <h2>Games</h2>
        </div>
        <button className="icon-button" aria-label="Refresh games" onClick={refresh}>
          <RefreshCcw size={18} />
        </button>
      </div>
      <div className="board-table">
        <MiniatureBoard />
        <div className="games-register">
          {home.games.length === 0 ? <p className="small">No games yet.</p> : null}
          {home.games.map((game) => (
            <div className="list-row game-row" key={game.id}>
              <span>{game.timeControl} · {game.status}{game.result ? ` · ${game.result}` : ""}</span>
              <button onClick={() => navigate(`/game/${game.id}`)}>Open</button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function GameScreen({ gameId, home, onHome, setMessage }: { gameId: string; home: HomeData; onHome: () => void; setMessage: (value: string) => void }) {
  const [game, setGame] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [now, setNow] = useState(Date.now());
  const myColor = game?.whiteId === home.user.id ? "w" : "b";
  const opponentId = game ? (game.whiteId === home.user.id ? game.blackId : game.whiteId) : "";
  const opponentState = game?.connectionState?.[opponentId] || "gone";

  async function load() {
    const data = await api<GameState>(`/api/games/${gameId}/state`);
    setGame(data);
  }

  useEffect(() => {
    void load();
    const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/games/${gameId}/socket`;
    const socket = new WebSocket(wsUrl);
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.game) setGame(payload.game);
    });
    socket.addEventListener("open", () => socket.send("sync"));
    return () => socket.close();
  }, [gameId]);

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

  if (!game) return <Shell home={home} message="Loading game..." />;
  return (
    <Shell home={home}>
      <section className="game-layout">
        <div className="board-wrap">
          <div className="clock-row">
            <strong>@{game.blackHandle}</strong>
            <time>{formatClock(liveClock(game, "b", now))}</time>
          </div>
          <div className="board-frame">
            <Board fen={game.fen} orientation={myColor || "w"} selected={selected} onSquare={choose} />
          </div>
          <div className="clock-row">
            <strong>@{game.whiteHandle}</strong>
            <time>{formatClock(liveClock(game, "w", now))}</time>
          </div>
        </div>
        <aside className="game-side">
          <div className="game-side-heading">
            <div className="side-seal" aria-hidden="true"><ElephantMark /></div>
            <button className="secondary" onClick={onHome}>Home</button>
          </div>
          <div className="status-box">
            <span>{game.status === "active" ? `${game.turn === "w" ? "White" : "Black"} to move` : game.status}</span>
            {game.result ? <strong>{game.result}</strong> : null}
          </div>
          <div className="status-box">
            <span>Opponent</span>
            <strong className={`connection ${opponentState}`}>{opponentState}</strong>
          </div>
          {confirmResign ? (
            <div className="confirm-row">
              <button className="danger" onClick={() => void resign()} disabled={game.status !== "active"}>
                <Flag size={18} />
                Confirm resign
              </button>
              <button className="secondary" onClick={() => setConfirmResign(false)}>Cancel</button>
            </div>
          ) : (
            <button className="danger" onClick={() => setConfirmResign(true)} disabled={game.status !== "active"}>
              <Flag size={18} />
              Resign
            </button>
          )}
          {game.moves.length ? (
            <ol className="moves">
              {game.moves.map((move, index) => <li key={`${move.at}-${index}`}>{move.san}</li>)}
            </ol>
          ) : null}
        </aside>
      </section>
    </Shell>
  );
}

function Board({ fen, orientation, selected, onSquare }: { fen: string; orientation: "w" | "b"; selected: Square | null; onSquare: (square: Square) => void }) {
  const chess = useMemo(() => new Chess(fen), [fen]);
  const board = chess.board();
  const rankList = orientation === "w" ? ranks : [...ranks].reverse();
  const fileList = orientation === "w" ? files : [...files].reverse();
  return (
    <div className="board" role="grid" aria-label="Chess board">
      {rankList.flatMap((rank) =>
        fileList.map((file) => {
          const square = `${file}${rank}` as Square;
          const piece = board[8 - Number(rank)][files.indexOf(file)];
          const dark = (files.indexOf(file) + Number(rank)) % 2 === 0;
          return (
            <button
              className={`square ${dark ? "dark" : "light"} ${selected === square ? "selected" : ""}`}
              data-square={square}
              key={square}
              onClick={() => void onSquare(square)}
              aria-label={square}
            >
              {ashtapadaMarks.has(square) ? <span className="ashtapada-mark" aria-hidden="true" /> : null}
              {piece ? <PieceGlyph color={piece.color} type={piece.type} /> : null}
            </button>
          );
        }),
      )}
    </div>
  );
}

function FriendSelect({ friends, value, onChange }: { friends: Friend[]; value: string; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Friend">
      <option value="">Friend</option>
      {friends.map((friend) => <option key={friend.id} value={friend.id}>@{friend.handle}</option>)}
    </select>
  );
}

function TimeSelect({ value, onChange }: { value: TimeControl; onChange: (value: TimeControl) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as TimeControl)} aria-label="Time control">
      <option value="10|0">10|0</option>
      <option value="5|0">5|0</option>
    </select>
  );
}

function MiniatureBoard() {
  return (
    <div className="miniature-board" aria-hidden="true">
      {Array.from({ length: 64 }).map((_, index) => {
        const file = files[index % 8];
        const rank = ranks[Math.floor(index / 8)];
        const square = `${file}${rank}`;
        return <span className={ashtapadaMarks.has(square) ? "marked" : ""} key={square} />;
      })}
    </div>
  );
}

function PieceGlyph({ color, type }: { color: Color; type: PieceSymbol }) {
  const title = `${color === "w" ? "white" : "black"} ${pieceNames[type]}`;
  return (
    <svg className={`piece piece-${color} piece-${type}`} viewBox="0 0 64 64" role="img" aria-label={title}>
      <path className="piece-ground" d="M14 54h36l4 6H10z" />
      {type === "p" ? (
        <>
          <circle className="piece-fill" cx="32" cy="19" r="8" />
          <path className="piece-fill" d="M22 45c2-15 18-15 20 0z" />
          <path className="piece-line" d="M25 34h14M32 27v17" />
        </>
      ) : null}
      {type === "n" ? (
        <>
          <path className="piece-fill" d="M19 47c2-18 4-29 22-37 6 7 8 15 5 25l-8-4-5 8 9 8z" />
          <path className="piece-line" d="M28 20c6 2 10 7 12 15M38 18h.1" />
        </>
      ) : null}
      {type === "b" ? (
        <>
          <path className="piece-fill" d="M17 42c0-17 11-28 28-28 8 0 13 5 13 12 0 5-4 9-9 9-6 0-9-5-7-10-8 1-13 8-13 18 0 6 2 10 7 13H18z" />
          <path className="piece-line" d="M18 42c-8 2-11 8-9 13 7 2 13-4 15-13M28 21c-8-7-18-3-17 6 1 7 7 11 16 12M38 15c0-8 8-12 14-8 5 4 4 12-2 16" />
          <circle className="piece-eye" cx="38" cy="30" r="2.4" />
        </>
      ) : null}
      {type === "r" ? (
        <>
          <path className="piece-fill" d="M17 23h30v20H17z" />
          <path className="piece-line" d="M20 18h24M20 18l5 5m19-5-5 5M22 45h20" />
          <circle className="piece-eye" cx="24" cy="47" r="3" />
          <circle className="piece-eye" cx="40" cy="47" r="3" />
        </>
      ) : null}
      {type === "q" ? (
        <>
          <path className="piece-fill" d="M16 44l7-25 9 12 9-12 7 25z" />
          <path className="piece-line" d="M21 18l11-8 11 8M24 43h16M32 31v13" />
        </>
      ) : null}
      {type === "k" ? (
        <>
          <path className="piece-fill" d="M18 44c2-18 8-27 14-27s12 9 14 27z" />
          <path className="piece-line" d="M20 19h24M24 19l8-10 8 10M25 34h14" />
          <circle className="piece-eye" cx="32" cy="24" r="2.4" />
        </>
      ) : null}
    </svg>
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

async function signOut() {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  navigate("/");
}

function navigate(path: string, after?: () => void) {
  window.history.pushState({}, "", path);
  if (after) void after();
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function ElephantMark() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" focusable="false">
      <path d="M26 56c0-18 12-30 30-30 12 0 22 7 22 19 0 8-5 13-12 13-6 0-10-4-10-10 0-4 2-7 5-9-2-2-5-3-9-3-10 0-17 8-17 20 0 11 7 20 18 20 8 0 15-4 19-10" />
      <path d="M25 57c-8 3-13 9-13 15 0 4 3 7 8 7 8 0 14-9 15-22" />
      <path d="M36 36c-8-11-20-8-22 1-2 8 4 16 18 18" />
      <path d="M64 26c-1-9 7-15 15-12 7 3 9 12 3 19" />
      <path d="M43 73v10M62 72v11M42 84h9M61 84h9" />
      <path d="M49 44h.1" />
    </svg>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
