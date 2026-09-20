/**
 * Realtime chat hub.
 *
 * Plain ESM (no build step) so it can be mounted straight into the custom
 * Node server that also serves the Next.js app. One process on Render's free
 * tier serves HTTP + WebSocket on the same port, which is why the public URL
 * is simply wss://<name>.onrender.com.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { WebSocketServer } from "ws";

const { Client } = pg;

export const PROTOCOL_VERSION = 1;
export const PRESENCE_TTL_SECONDS = 45;
export const MAX_MESSAGE_LENGTH = 2000;
export const CHAT_EVENT_CHANNEL = "chat_events";

const HEARTBEAT_MS = 20_000;
const SWEEP_MS = 15_000;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 15;
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9 _.-]{0,30}[a-zA-Z0-9])?$/;

const CLOSE = {
  BAD_REQUEST: 4400,
  JOIN_REQUIRED: 4401,
  ROOM_NOT_FOUND: 4404,
  USERNAME_TAKEN: 4409,
  ROOM_FULL: 4403,
  RATE_LIMITED: 4429,
  SERVER_ERROR: 4500,
  GOING_AWAY: 1001,
};

function normalizeRoomCode(raw) {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function validateUsername(raw) {
  if (typeof raw !== "string") return { ok: false, error: "username must be a string" };
  const username = raw.trim().replace(/\s+/g, " ");
  if (username.length < 2 || username.length > 32) {
    return { ok: false, error: "username must be between 2 and 32 characters" };
  }
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      error: "username may only contain letters, numbers, spaces, dot, dash and underscore",
    };
  }
  return { ok: true, username, key: username.toLowerCase() };
}

function sanitizeMessage(raw) {
  if (typeof raw !== "string") return null;
  const body = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!body) return null;
  return body.slice(0, MAX_MESSAGE_LENGTH);
}

function rowToMessage(row) {
  return {
    id: row.id,
    room: row.room_code,
    username: row.username,
    body: row.body,
    kind: row.kind,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function rowToMember(row) {
  return {
    username: row.username,
    transport: row.transport,
    joinedAt: new Date(row.joined_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  };
}

/**
 * @param {{ pool: import('pg').Pool, databaseUrl: string, log?: (...args: any[]) => void }} options
 */
export function createChatHub({ pool, databaseUrl, log = console.log }) {
  const hubId = randomUUID();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  /** @type {Map<string, Set<any>>} room code -> sockets */
  const roomSockets = new Map();
  let listener = null;
  let closed = false;

  const stats = { connections: 0, joined: 0, messages: 0, startedAt: new Date().toISOString() };

  const query = (text, values = []) => pool.query(text, values);

  function send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      log("[hub] send failed:", error.message);
    }
  }

  function sendError(ws, code, message, extra = {}) {
    send(ws, { type: "error", code, message, ...extra });
  }

  function broadcast(room, payload, { except } = {}) {
    const set = roomSockets.get(room);
    if (!set) return 0;
    const data = JSON.stringify(payload);
    let count = 0;
    for (const client of set) {
      if (client === except) continue;
      if (client.readyState !== client.OPEN) continue;
      try {
        client.send(data);
        count += 1;
      } catch {
        /* ignore broken pipe */
      }
    }
    return count;
  }

  async function notify(payload) {
    try {
      const body = JSON.stringify({ ...payload, v: PROTOCOL_VERSION, origin: hubId });
      if (body.length > 7000) return;
      await query("select pg_notify($1, $2)", [CHAT_EVENT_CHANNEL, body]);
    } catch (error) {
      log("[hub] notify failed:", error.message);
    }
  }

  async function getRoom(code) {
    const { rows } = await query(
      "select code, name, topic, max_members, is_locked from rooms where code = $1 limit 1",
      [code],
    );
    return rows[0] ?? null;
  }

  async function listMembers(code) {
    const { rows } = await query(
      `select username, transport, joined_at, last_seen_at
         from room_members
        where room_code = $1
          and last_seen_at > now() - make_interval(secs => $2)
        order by joined_at asc`,
      [code, PRESENCE_TTL_SECONDS],
    );
    return rows.map(rowToMember);
  }

  async function listHistory(code, limit = 50, before = null) {
    const { rows } = await query(
      `select id, room_code, username, body, kind, created_at
         from messages
        where room_code = $1 and ($2::int is null or id < $2::int)
        order by id desc
        limit $3`,
      [code, before, Math.min(Math.max(Number(limit) || 50, 1), 200)],
    );
    return rows.reverse().map(rowToMessage);
  }

  async function insertMessage(code, username, body, kind = "chat") {
    const { rows } = await query(
      `insert into messages (room_code, username, body, kind)
       values ($1, $2, $3, $4)
       returning id, room_code, username, body, kind, created_at`,
      [code, username, body, kind],
    );
    await query("update rooms set last_activity_at = now() where code = $1", [code]);
    return rowToMessage(rows[0]);
  }

  async function claimMembership({ code, username, key, sessionId, maxMembers }) {
    await query(
      "delete from room_members where last_seen_at < now() - make_interval(secs => $1)",
      [PRESENCE_TTL_SECONDS],
    );

    const { rows: existing } = await query(
      `select session_id from room_members
        where room_code = $1 and username_key = $2
          and last_seen_at > now() - make_interval(secs => $3)`,
      [code, key, PRESENCE_TTL_SECONDS],
    );

    if (!existing.length) {
      const { rows: counted } = await query(
        `select count(*)::int as count from room_members
          where room_code = $1 and last_seen_at > now() - make_interval(secs => $2)`,
        [code, PRESENCE_TTL_SECONDS],
      );
      if ((counted[0]?.count ?? 0) >= maxMembers) return { status: "full" };
    }

    const { rows } = await query(
      `insert into room_members (room_code, username_key, username, session_id, transport, joined_at, last_seen_at)
       values ($1, $2, $3, $4, 'ws', now(), now())
       on conflict (room_code, username_key) do update
         set session_id = excluded.session_id,
             username = excluded.username,
             transport = 'ws',
             last_seen_at = now()
         where room_members.session_id = excluded.session_id
            or room_members.last_seen_at < now() - make_interval(secs => $5)
       returning (xmax = 0) as inserted`,
      [code, key, username, sessionId, PRESENCE_TTL_SECONDS],
    );

    if (!rows.length) return { status: "taken" };
    return { status: rows[0].inserted ? "joined" : "rejoined" };
  }

  async function releaseMembership(code, key, sessionId) {
    const { rowCount } = await query(
      "delete from room_members where room_code = $1 and username_key = $2 and session_id = $3",
      [code, key, sessionId],
    );
    return rowCount > 0;
  }

  function trackSocket(ws) {
    let set = roomSockets.get(ws.state.room);
    if (!set) {
      set = new Set();
      roomSockets.set(ws.state.room, set);
    }
    set.add(ws);
  }

  function untrackSocket(ws) {
    const set = roomSockets.get(ws.state.room);
    if (!set) return;
    set.delete(ws);
    if (!set.size) roomSockets.delete(ws.state.room);
  }

  async function handleJoin(ws, frame) {
    const state = ws.state;
    if (state.room && state.username) {
      sendError(ws, "ALREADY_JOINED", `already joined ${state.room} as ${state.username}`);
      return;
    }

    const code = normalizeRoomCode(frame.room ?? frame.code ?? frame.roomCode);
    if (!code) {
      sendError(ws, "INVALID_ROOM", "a room code is required to join");
      return;
    }
    const check = validateUsername(frame.username ?? frame.name);
    if (!check.ok) {
      sendError(ws, "INVALID_USERNAME", check.error);
      return;
    }

    const room = await getRoom(code);
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", `no room with code ${code}`, { room: code });
      ws.close(CLOSE.ROOM_NOT_FOUND, "room not found");
      return;
    }
    if (room.is_locked) {
      sendError(ws, "ROOM_LOCKED", "this room is locked");
      ws.close(CLOSE.BAD_REQUEST, "room locked");
      return;
    }

    const sessionId =
      typeof frame.sessionId === "string" && frame.sessionId.length >= 8
        ? frame.sessionId.slice(0, 40)
        : randomUUID();

    const claim = await claimMembership({
      code,
      username: check.username,
      key: check.key,
      sessionId,
      maxMembers: room.max_members,
    });

    if (claim.status === "taken") {
      sendError(ws, "USERNAME_TAKEN", `the username "${check.username}" is already in room ${code}`, {
        room: code,
        username: check.username,
      });
      ws.close(CLOSE.USERNAME_TAKEN, "username taken");
      return;
    }
    if (claim.status === "full") {
      sendError(ws, "ROOM_FULL", `room ${code} is full`);
      ws.close(CLOSE.ROOM_FULL, "room full");
      return;
    }

    state.room = code;
    state.username = check.username;
    state.usernameKey = check.key;
    state.sessionId = sessionId;
    state.joinedAt = Date.now();
    trackSocket(ws);
    stats.joined += 1;

    const [members, history] = await Promise.all([
      listMembers(code),
      listHistory(code, frame.history ?? 50),
    ]);

    send(ws, {
      type: "joined",
      status: claim.status,
      room: { code: room.code, name: room.name, topic: room.topic, maxMembers: room.max_members },
      username: check.username,
      sessionId,
      members,
      history,
      serverTime: new Date().toISOString(),
    });

    if (claim.status === "joined") {
      const systemMessage = await insertMessage(
        code,
        check.username,
        `${check.username} joined the room`,
        "system",
      );
      broadcast(code, { type: "message", ...systemMessage }, { except: ws });
      broadcast(code, {
        type: "presence",
        event: "join",
        room: code,
        username: check.username,
        members,
      });
      await notify({ type: "message", room: code, message: systemMessage });
      await notify({ type: "presence", room: code, event: "join", username: check.username });
    }
  }

  async function handleLeave(ws, { silent = false, closeSocket = true } = {}) {
    const state = ws.state;
    if (!state.room || !state.username || state.leaving) {
      if (closeSocket && ws.readyState === ws.OPEN) ws.close(CLOSE.GOING_AWAY, "bye");
      return;
    }
    state.leaving = true;
    const { room, username, usernameKey, sessionId } = state;
    untrackSocket(ws);

    try {
      const released = await releaseMembership(room, usernameKey, sessionId);
      if (released && !silent) {
        const systemMessage = await insertMessage(
          room,
          username,
          `${username} left the room`,
          "system",
        );
        const members = await listMembers(room);
        broadcast(room, { type: "message", ...systemMessage });
        broadcast(room, { type: "presence", event: "leave", room, username, members });
        await notify({ type: "message", room, message: systemMessage });
        await notify({ type: "presence", room, event: "leave", username });
      }
    } catch (error) {
      log("[hub] leave failed:", error.message);
    }

    state.room = null;
    state.username = null;
    if (closeSocket && ws.readyState === ws.OPEN) ws.close(CLOSE.GOING_AWAY, "bye");
  }

  function rateLimited(ws) {
    const now = Date.now();
    const state = ws.state;
    if (now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
      state.windowStart = now;
      state.windowCount = 0;
    }
    state.windowCount += 1;
    return state.windowCount > RATE_LIMIT_MAX;
  }

  async function handleChat(ws, frame) {
    const state = ws.state;
    if (!state.room || !state.username) {
      sendError(ws, "JOIN_REQUIRED", "send a join frame before chatting");
      return;
    }
    const body = sanitizeMessage(frame.text ?? frame.body ?? frame.message ?? frame.content);
    if (!body) {
      sendError(ws, "EMPTY_MESSAGE", "text is required");
      return;
    }
    if (rateLimited(ws)) {
      sendError(ws, "RATE_LIMITED", "slow down – too many messages");
      return;
    }

    const message = await insertMessage(state.room, state.username, body);
    stats.messages += 1;
    if (frame.nonce) send(ws, { type: "ack", nonce: String(frame.nonce).slice(0, 64), id: message.id });
    broadcast(state.room, { type: "message", ...message });
    await notify({ type: "message", room: state.room, message });
  }

  async function handleFrame(ws, raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      sendError(ws, "INVALID_JSON", "frames must be JSON objects");
      return;
    }
    if (!frame || typeof frame !== "object") {
      sendError(ws, "INVALID_FRAME", "frames must be JSON objects");
      return;
    }

    const type = String(frame.type ?? "message").toLowerCase();
    switch (type) {
      case "join":
        await handleJoin(ws, frame);
        return;
      case "message":
      case "chat":
      case "say":
        await handleChat(ws, frame);
        return;
      case "typing": {
        const state = ws.state;
        if (!state.room || !state.username) return;
        broadcast(
          state.room,
          {
            type: "typing",
            room: state.room,
            username: state.username,
            isTyping: frame.isTyping !== false,
          },
          { except: ws },
        );
        return;
      }
      case "history": {
        const state = ws.state;
        if (!state.room) {
          sendError(ws, "JOIN_REQUIRED", "join a room first");
          return;
        }
        const history = await listHistory(state.room, frame.limit ?? 50, frame.before ?? null);
        send(ws, { type: "history", room: state.room, messages: history });
        return;
      }
      case "members": {
        const state = ws.state;
        if (!state.room) {
          sendError(ws, "JOIN_REQUIRED", "join a room first");
          return;
        }
        send(ws, { type: "members", room: state.room, members: await listMembers(state.room) });
        return;
      }
      case "ping":
        send(ws, { type: "pong", t: frame.t ?? Date.now() });
        return;
      case "leave":
        await handleLeave(ws, { closeSocket: false });
        send(ws, { type: "left", ok: true });
        return;
      default:
        sendError(ws, "UNKNOWN_TYPE", `unsupported frame type "${type}"`);
    }
  }

  wss.on("connection", (ws, request, context) => {
    stats.connections += 1;
    ws.isAlive = true;
    ws.state = {
      id: randomUUID(),
      room: null,
      username: null,
      usernameKey: null,
      sessionId: null,
      windowStart: Date.now(),
      windowCount: 0,
      leaving: false,
    };

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    send(ws, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      hub: hubId,
      connectionId: ws.state.id,
      serverTime: new Date().toISOString(),
      maxMessageLength: MAX_MESSAGE_LENGTH,
      presenceTtlSeconds: PRESENCE_TTL_SECONDS,
      hint: 'send {"type":"join","room":"CODE","username":"you"}',
    });

    ws.on("message", (data) => {
      handleFrame(ws, data.toString()).catch((error) => {
        log("[hub] frame error:", error);
        sendError(ws, "SERVER_ERROR", "could not process that frame");
      });
    });

    ws.on("close", () => {
      handleLeave(ws, { closeSocket: false }).catch(() => {});
    });

    ws.on("error", () => {
      handleLeave(ws, { closeSocket: false }).catch(() => {});
    });

    // Auto-join when the URL already carries ?room=&username=
    if (context?.room && context?.username) {
      handleJoin(ws, {
        room: context.room,
        username: context.username,
        sessionId: context.sessionId,
      }).catch((error) => {
        log("[hub] auto-join failed:", error);
        sendError(ws, "SERVER_ERROR", "join failed");
      });
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);

  const sweeper = setInterval(() => {
    void (async () => {
      try {
        const live = [];
        for (const ws of wss.clients) {
          if (ws.state?.room && ws.state?.usernameKey && ws.state?.sessionId) {
            live.push(ws.state);
          }
        }
        if (live.length) {
          await query(
            `update room_members set last_seen_at = now()
              where (room_code, username_key, session_id) in (
                select * from unnest($1::text[], $2::text[], $3::text[])
              )`,
            [
              live.map((s) => s.room),
              live.map((s) => s.usernameKey),
              live.map((s) => s.sessionId),
            ],
          );
        }
        const { rows } = await query(
          `delete from room_members
            where last_seen_at < now() - make_interval(secs => $1)
            returning room_code, username`,
          [PRESENCE_TTL_SECONDS],
        );
        for (const row of rows) {
          const members = await listMembers(row.room_code);
          broadcast(row.room_code, {
            type: "presence",
            event: "timeout",
            room: row.room_code,
            username: row.username,
            members,
          });
        }
      } catch (error) {
        log("[hub] sweep failed:", error.message);
      }
    })();
  }, SWEEP_MS);

  async function startListener() {
    if (closed) return;
    listener = new Client({ connectionString: databaseUrl });
    listener.on("error", (error) => {
      log("[hub] listener error:", error.message);
      try {
        listener?.end();
      } catch {
        /* ignore */
      }
      listener = null;
      if (!closed) setTimeout(() => void startListener(), 2000);
    });
    listener.on("notification", (note) => {
      if (note.channel !== CHAT_EVENT_CHANNEL || !note.payload) return;
      let event;
      try {
        event = JSON.parse(note.payload);
      } catch {
        return;
      }
      if (!event || event.origin === hubId) return;
      if (event.type === "message" && event.message) {
        broadcast(event.room, { type: "message", ...event.message });
      } else if (event.type === "presence") {
        void listMembers(event.room).then((members) => {
          broadcast(event.room, {
            type: "presence",
            event: event.event,
            room: event.room,
            username: event.username,
            members,
          });
        });
      } else if (event.type === "typing") {
        broadcast(event.room, {
          type: "typing",
          room: event.room,
          username: event.username,
          isTyping: event.isTyping !== false,
        });
      }
    });

    try {
      await listener.connect();
      await listener.query(`listen ${CHAT_EVENT_CHANNEL}`);
      log(`[hub] listening on postgres channel "${CHAT_EVENT_CHANNEL}"`);
    } catch (error) {
      log("[hub] could not start listener:", error.message);
      listener = null;
      if (!closed) setTimeout(() => void startListener(), 3000);
    }
  }

  void startListener();

  /** Which URL paths this hub answers websocket upgrades on. */
  function matchUpgrade(pathname) {
    const clean = pathname.replace(/\/+$/, "") || "/";
    if (clean === "/" || clean === "/ws" || clean === "/websocket" || clean === "/api/ws") {
      return { matched: true, room: null };
    }
    const roomPath = clean.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})\/ws$/);
    if (roomPath) return { matched: true, room: normalizeRoomCode(roomPath[1]) };
    const shortPath = clean.match(/^\/ws\/([A-Za-z0-9]{4,12})$/);
    if (shortPath) return { matched: true, room: normalizeRoomCode(shortPath[1]) };
    return { matched: false, room: null };
  }

  function handleUpgrade(request, socket, head, match) {
    const url = new URL(request.url, "http://localhost");
    const room = normalizeRoomCode(url.searchParams.get("room") ?? match?.room ?? "");
    const username = url.searchParams.get("username") ?? url.searchParams.get("user") ?? null;
    const sessionId = url.searchParams.get("sessionId") ?? undefined;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, {
        room: room || null,
        username: username ? username.trim() : null,
        sessionId,
      });
    });
  }

  async function close() {
    closed = true;
    clearInterval(heartbeat);
    clearInterval(sweeper);
    for (const ws of wss.clients) {
      try {
        ws.close(CLOSE.GOING_AWAY, "server shutting down");
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => wss.close(resolve));
    if (listener) {
      try {
        await listener.end();
      } catch {
        /* ignore */
      }
    }
  }

  function snapshot() {
    return {
      hubId,
      rooms: roomSockets.size,
      sockets: wss.clients.size,
      ...stats,
    };
  }

  return { hubId, wss, matchUpgrade, handleUpgrade, close, snapshot };
}
