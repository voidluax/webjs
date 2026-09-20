"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useChatConnection, type ChatMessage } from "@/hooks/useChatConnection";

type LobbyRoom = {
  code: string;
  name: string;
  topic: string | null;
  members: number;
  lastActivityAt: string;
};

const AVATAR_COLORS = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-cyan-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-pink-500",
];

function colorFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initials(name: string) {
  const parts = name.trim().split(/[\s_.-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function clockOf(iso: string) {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatApp() {
  const chat = useChatConnection();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [username, setUsername] = useState("");
  const [roomName, setRoomName] = useState("");
  const [topic, setTopic] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyRoom[]>([]);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const typingSentAt = useRef(0);

  const inRoom = chat.status === "connected" || chat.status === "reconnecting";

  useEffect(() => {
    setOrigin(window.location.host);
    const saved = window.localStorage.getItem("chat:username");
    if (saved) setUsername(saved);
    const params = new URLSearchParams(window.location.search);
    const code = params.get("room");
    if (code) {
      setMode("join");
      setJoinCode(code.toUpperCase());
    }
  }, []);

  const refreshLobby = useCallback(async () => {
    try {
      const res = await fetch("/api/rooms?limit=8", { cache: "no-store" });
      const data = await res.json();
      if (data?.rooms) setLobby(data.rooms);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (inRoom) return;
    void refreshLobby();
    const timer = setInterval(() => void refreshLobby(), 8000);
    return () => clearInterval(timer);
  }, [inRoom, refreshLobby]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat.messages]);

  const wsUrl = useMemo(() => {
    if (!origin) return "";
    const secure = typeof window !== "undefined" && window.location.protocol === "https:";
    return `${secure ? "wss" : "ws"}://${origin}`;
  }, [origin]);

  const copy = useCallback(async (value: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard blocked */
    }
  }, []);

  const handleCreate = async () => {
    setFormError(null);
    if (username.trim().length < 2) {
      setFormError("Pick a username with at least 2 characters.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: roomName.trim() || `${username.trim()}'s room`,
          topic: topic.trim() || undefined,
          username: username.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data?.error?.message ?? "Could not create the room.");
        return;
      }
      window.localStorage.setItem("chat:username", username.trim());
      chat.connect({ room: data.room.code, username: username.trim(), roomInfo: data.room });
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    setFormError(null);
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) {
      setFormError("Enter the room code you were given.");
      return;
    }
    if (username.trim().length < 2) {
      setFormError("Pick a username with at least 2 characters.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/rooms/${code}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data?.error?.message ?? "Room not found.");
        return;
      }
      const taken = (data.members ?? []).some(
        (m: { username: string }) => m.username.toLowerCase() === username.trim().toLowerCase(),
      );
      if (taken) {
        setFormError(`"${username.trim()}" is already in room ${code}. Choose another name.`);
        return;
      }
      window.localStorage.setItem("chat:username", username.trim());
      chat.connect({ room: code, username: username.trim(), roomInfo: data.room });
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitMessage = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    chat.sendMessage(draft);
    setDraft("");
    chat.sendTyping(false);
  };

  const onDraftChange = (value: string) => {
    setDraft(value);
    const now = Date.now();
    if (now - typingSentAt.current > 1500) {
      typingSentAt.current = now;
      chat.sendTyping(true);
    }
  };

  /* ----------------------------------------------------------- lobby view */

  if (!inRoom) {
    const fatal = chat.error;
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 shadow-2xl backdrop-blur">
          <div className="mb-5 flex gap-2 rounded-xl bg-slate-950/60 p-1 text-sm font-medium">
            {(["create", "join"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setMode(tab);
                  setFormError(null);
                }}
                className={`flex-1 rounded-lg px-4 py-2 transition ${
                  mode === tab
                    ? "bg-indigo-500 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {tab === "create" ? "Create a room" : "Join with code"}
              </button>
            ))}
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Username
              </span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ada"
                maxLength={32}
                className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2.5 text-slate-100 outline-none ring-indigo-500/60 placeholder:text-slate-600 focus:ring-2"
              />
              <span className="mt-1 block text-xs text-slate-500">
                Must be unique inside the room — duplicates are rejected by the server.
              </span>
            </label>

            {mode === "create" ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Room name
                  </span>
                  <input
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    placeholder="Deploy party"
                    maxLength={80}
                    className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2.5 text-slate-100 outline-none ring-indigo-500/60 placeholder:text-slate-600 focus:ring-2"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Topic <span className="text-slate-600">(optional)</span>
                  </span>
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="Shipping the websocket server"
                    maxLength={200}
                    className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2.5 text-slate-100 outline-none ring-indigo-500/60 placeholder:text-slate-600 focus:ring-2"
                  />
                </label>
                <button
                  onClick={() => void handleCreate()}
                  disabled={busy}
                  className="w-full rounded-lg bg-indigo-500 px-4 py-3 font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
                >
                  {busy ? "Creating…" : "Create room & get code"}
                </button>
              </>
            ) : (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Room code
                  </span>
                  <input
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="K7P2QX"
                    maxLength={12}
                    className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2.5 font-mono text-lg tracking-[0.3em] text-slate-100 outline-none ring-indigo-500/60 placeholder:tracking-[0.3em] placeholder:text-slate-600 focus:ring-2"
                  />
                </label>
                <button
                  onClick={() => void handleJoin()}
                  disabled={busy}
                  className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-semibold text-white transition hover:bg-emerald-400 disabled:opacity-50"
                >
                  {busy ? "Joining…" : "Join room"}
                </button>
              </>
            )}

            {(formError || fatal) && (
              <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {formError ?? `${fatal?.code}: ${fatal?.message}`}
              </p>
            )}
            {chat.status === "connecting" && (
              <p className="text-sm text-slate-400">Opening websocket…</p>
            )}
          </div>
        </section>

        <section className="space-y-4">
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5 backdrop-blur">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
              Live rooms
            </h3>
            {lobby.length === 0 ? (
              <p className="text-sm text-slate-500">
                No rooms yet. Create one — the code is generated for you.
              </p>
            ) : (
              <ul className="space-y-2">
                {lobby.map((item) => (
                  <li key={item.code}>
                    <button
                      onClick={() => {
                        setMode("join");
                        setJoinCode(item.code);
                        setFormError(null);
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/5 bg-slate-950/50 px-3 py-2.5 text-left transition hover:border-indigo-400/50 hover:bg-slate-950"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-200">
                          {item.name}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {item.topic ?? "no topic"}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end">
                        <span className="font-mono text-xs tracking-widest text-indigo-300">
                          {item.code}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {item.members} online
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5 font-mono text-xs text-slate-400 backdrop-blur">
            <p className="mb-2 font-sans text-sm font-semibold uppercase tracking-wider text-slate-400">
              Endpoints
            </p>
            <p className="break-all text-emerald-300">{wsUrl || "wss://name.onrender.com"}/ws</p>
            <p className="break-all text-sky-300">POST /api/rooms</p>
            <p className="break-all text-sky-300">POST /api/rooms/:code/join</p>
            <p className="break-all text-sky-300">GET&nbsp; /api/rooms/:code/messages</p>
          </div>
        </section>
      </div>
    );
  }

  /* ------------------------------------------------------------ chat view */

  const code = chat.room?.code ?? "";
  const statusTone =
    chat.status === "connected"
      ? "bg-emerald-500"
      : chat.status === "reconnecting"
        ? "bg-amber-400"
        : "bg-rose-500";

  return (
    <div className="mx-auto flex h-[78vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/70 shadow-2xl backdrop-blur">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-slate-100">{chat.room?.name}</h2>
          <p className="truncate text-xs text-slate-500">
            {chat.room?.topic ?? "no topic"} · you are{" "}
            <span className="text-slate-300">{chat.username}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void copy(code, "code")}
            className="rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-3 py-1.5 font-mono text-sm tracking-[0.25em] text-indigo-200 transition hover:bg-indigo-500/20"
            title="Copy room code"
          >
            {copied === "code" ? "copied!" : code}
          </button>
          <button
            onClick={() => void copy(`${wsUrl}/ws?room=${code}&username=YOUR_NAME`, "ws")}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-3 py-1.5 text-xs text-slate-400 transition hover:text-slate-200"
            title="Copy websocket URL"
          >
            {copied === "ws" ? "copied!" : "copy wss://"}
          </button>
          <span className="flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950/60 px-3 py-1.5 text-xs text-slate-400">
            <span className={`h-2 w-2 rounded-full ${statusTone} animate-pulse`} />
            {chat.transport === "websocket" ? "websocket" : "http fallback"}
          </span>
          <button
            onClick={chat.disconnect}
            className="rounded-lg bg-rose-500/90 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-rose-500"
          >
            Leave
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-56 shrink-0 flex-col border-r border-white/10 bg-slate-950/40 p-4 sm:flex">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
            In room · {chat.members.length}
          </h3>
          <ul className="space-y-1.5 overflow-y-auto">
            {chat.members.map((member) => (
              <li key={member.username} className="flex items-center gap-2.5">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${colorFor(member.username)}`}
                >
                  {initials(member.username)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-300">
                  {member.username}
                  {member.username === chat.username && (
                    <span className="text-slate-600"> (you)</span>
                  )}
                </span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    member.transport === "ws" ? "bg-emerald-400" : "bg-sky-400"
                  }`}
                  title={member.transport === "ws" ? "websocket" : "http"}
                />
              </li>
            ))}
          </ul>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {chat.messages.map((message) => (
              <MessageRow key={`${message.id}-${message.pending ? "p" : "s"}`} message={message} me={chat.username} />
            ))}
            {chat.messages.length === 0 && (
              <p className="py-10 text-center text-sm text-slate-600">
                Nothing here yet — say hello 👋
              </p>
            )}
          </div>

          <div className="h-5 px-5 text-xs text-slate-500">
            {chat.typing.filter((name) => name !== chat.username).length > 0 &&
              `${chat.typing.filter((n) => n !== chat.username).join(", ")} typing…`}
          </div>

          <form onSubmit={submitMessage} className="flex gap-2 border-t border-white/10 p-4">
            <input
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              placeholder={`Message ${chat.room?.name ?? ""}`}
              maxLength={2000}
              className="flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none ring-indigo-500/60 placeholder:text-slate-600 focus:ring-2"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="rounded-lg bg-indigo-500 px-5 py-3 font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message, me }: { message: ChatMessage; me: string }) {
  if (message.kind === "system") {
    return (
      <p className="text-center text-xs italic text-slate-500">
        {message.body} · {clockOf(message.createdAt)}
      </p>
    );
  }
  const mine = message.username === me;
  return (
    <div className={`flex gap-3 ${mine ? "flex-row-reverse" : ""}`}>
      <span
        className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${colorFor(message.username)}`}
      >
        {initials(message.username)}
      </span>
      <div className={`max-w-[75%] ${mine ? "text-right" : ""}`}>
        <p className="mb-1 text-xs text-slate-500">
          <span className="font-medium text-slate-400">{message.username}</span> ·{" "}
          {clockOf(message.createdAt)}
          {message.pending && " · sending"}
        </p>
        <div
          className={`inline-block whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-sm ${
            mine
              ? "rounded-tr-sm bg-indigo-500 text-white"
              : "rounded-tl-sm bg-slate-800 text-slate-100"
          } ${message.pending ? "opacity-60" : ""}`}
        >
          {message.body}
        </div>
      </div>
    </div>
  );
}
