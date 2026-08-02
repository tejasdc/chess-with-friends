import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, CalendarClock, Copy, Flag, LogOut, Plus, RefreshCcw, Send, Share2, Sword } from "lucide-react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Chess, type Color, type PieceSymbol, type Square } from "chess.js";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import "./styles.css";

type TimeControl = "10|0" | "5|0";
type GameStatus = "active" | "checkmate" | "resigned" | "timeout" | "draw";

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
  turn: "w" | "b";
  status: GameStatus;
  result?: string;
  winnerId?: string;
  loserId?: string;
  connectionState: Record<string, "connected" | "reconnecting" | "gone">;
}

const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
const pieces: Record<Color, Record<PieceSymbol, string>> = {
  w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" },
};

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
      <InstallPanel home={home} setMessage={setMessage} />
      {inviteMatch ? <InvitePanel token={inviteMatch[1]} refresh={refresh} setMessage={setMessage} /> : null}
      <FriendPanel home={home} refresh={refresh} setMessage={setMessage} />
      <ChallengePanel home={home} refresh={refresh} setMessage={setMessage} />
      <SchedulePanel home={home} refresh={refresh} setMessage={setMessage} />
      <GamesPanel home={home} refresh={refresh} />
    </Shell>
  );
}

function Shell({ children, home, message }: { children?: React.ReactNode; home?: HomeData | null; message?: string }) {
  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => navigate("/")}>Chess with Friends</button>
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
      {children}
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
        <div>
          <p className="eyebrow">Friends-only live chess</p>
          <h1>Sit down when your friend is ready.</h1>
        </div>
        <label>
          Handle
          <input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="your_handle" autoComplete="username webauthn" />
        </label>
        <div className="button-row">
          <button onClick={register} disabled={busy || !handle}>Create passkey</button>
          <button className="secondary" onClick={login} disabled={busy || !handle}>Sign in</button>
        </div>
        <p className="small">No email or phone number. Your passkey is the account anchor.</p>
      </section>
    </Shell>
  );
}

function InstallPanel({ home, setMessage }: { home: HomeData; setMessage: (value: string) => void }) {
  async function enablePush() {
    try {
      if (!home.pushPublicKey) throw new Error("Push key is not configured on this deployment.");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(home.pushPublicKey),
      });
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription }) });
      setMessage("Notifications enabled for friend requests, challenges, and scheduled games.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Notification setup failed.");
    }
  }

  return (
    <section className="panel install">
      <div>
        <h2>Install</h2>
        <p>On iPhone, open Share and choose Add to Home Screen before enabling notifications.</p>
      </div>
      <button onClick={enablePush}>
        <Bell size={18} />
        Enable notifications
      </button>
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
    <section className="panel accent-panel">
      <h2>Invite link</h2>
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
    <section className="panel">
      <div className="panel-heading">
        <h2>Friends</h2>
        <button className="icon-button" aria-label="Copy invite link" onClick={() => void navigator.clipboard.writeText(invite)}>
          <Copy size={18} />
        </button>
      </div>
      <div className="inline-form">
        <input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="friend_handle" />
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
    <section className="panel">
      <h2>Challenge</h2>
      <div className="inline-form">
        <FriendSelect friends={home.friends} value={friendId} onChange={setFriendId} />
        <TimeSelect value={timeControl} onChange={setTimeControl} />
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
    <section className="panel">
      <h2>Schedule</h2>
      <div className="inline-form">
        <FriendSelect friends={home.friends} value={friendId} onChange={setFriendId} />
        <TimeSelect value={timeControl} onChange={setTimeControl} />
        <label className="compact-label">
          Minutes
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
            @{schedule.fromHandle} → @{schedule.toHandle}, {new Date(schedule.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}, {schedule.status}
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
    <section className="panel">
      <div className="panel-heading">
        <h2>Games</h2>
        <button className="icon-button" aria-label="Refresh games" onClick={refresh}>
          <RefreshCcw size={18} />
        </button>
      </div>
      {home.games.length === 0 ? <p className="small">No games yet.</p> : null}
      {home.games.map((game) => (
        <div className="list-row" key={game.id}>
          <span>{game.timeControl} · {game.status}{game.result ? ` · ${game.result}` : ""}</span>
          <button onClick={() => navigate(`/game/${game.id}`)}>Open</button>
        </div>
      ))}
    </section>
  );
}

function GameScreen({ gameId, home, onHome, setMessage }: { gameId: string; home: HomeData; onHome: () => void; setMessage: (value: string) => void }) {
  const [game, setGame] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
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
  }

  if (!game) return <Shell home={home} message="Loading game..." />;
  return (
    <Shell home={home}>
      <section className="game-layout">
        <div className="board-wrap">
          <div className="clock-row">
            <strong>@{game.blackHandle}</strong>
            <time>{formatClock(game.blackMs)}</time>
          </div>
          <Board fen={game.fen} orientation={myColor || "w"} selected={selected} onSquare={choose} />
          <div className="clock-row">
            <strong>@{game.whiteHandle}</strong>
            <time>{formatClock(game.whiteMs)}</time>
          </div>
        </div>
        <aside className="game-side">
          <button className="secondary" onClick={onHome}>Home</button>
          <div className="status-box">
            <span>{game.status === "active" ? `${game.turn === "w" ? "White" : "Black"} to move` : game.status}</span>
            {game.result ? <strong>{game.result}</strong> : null}
          </div>
          <div className="status-box">
            <span>Opponent</span>
            <strong className={`connection ${opponentState}`}>{opponentState}</strong>
          </div>
          <button className="danger" onClick={() => void resign()} disabled={game.status !== "active"}>
            <Flag size={18} />
            Resign
          </button>
          <ol className="moves">
            {game.moves.map((move, index) => <li key={`${move.at}-${index}`}>{move.san}</li>)}
          </ol>
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
              {piece ? pieces[piece.color][piece.type] : ""}
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

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60).toString();
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
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

createRoot(document.getElementById("root")!).render(<App />);
