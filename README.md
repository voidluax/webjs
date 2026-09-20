# Render Chat — WebSocket rooms with join codes

A self-contained realtime chat app you can deploy to **Render's free tier**. It ships its **own
WebSocket server** mounted on the same port as the HTTP app, so the public endpoints are simply:

| | URL |
|---|---|
| Web UI / REST API | `https://<name>.onrender.com` |
| WebSocket | `wss://<name>.onrender.com` (also `/ws`, `/ws/:code`, `/api/rooms/:code/ws`) |
| Create a room | `POST https://<name>.onrender.com/api/rooms` |

**How it works:** create a room over REST → you get a short **join code** → connect a WebSocket with
that code plus a **username** → chat. A username may only be held by one connection per room; a
second person using the same name is **refused**.

---

## Table of contents

- [Quick start](#quick-start)
- [Deploy to Render (free tier)](#deploy-to-render-free-tier)
- [REST API](#rest-api)
  - [POST /api/rooms](#post-apirooms)
  - [GET /api/rooms](#get-apirooms)
  - [GET /api/rooms/:code](#get-apiroomscode)
  - [POST /api/rooms/:code/join](#post-apiroomscodejoin)
  - [POST /api/rooms/:code/messages](#post-apiroomscodemessages)
  - [GET /api/rooms/:code/messages](#get-apiroomscodemessages)
  - [POST /api/rooms/:code/presence](#post-apiroomscodepresence)
  - [POST /api/rooms/:code/leave](#post-apiroomscodeleave)
  - [GET /api/health](#get-apihealth)
- [WebSocket API](#websocket-api)
  - [Connecting](#connecting)
  - [Client → server frames](#client--server-frames)
  - [Server → client frames](#server--client-frames)
  - [Close codes](#close-codes)
- [Username rules](#username-rules)
- [Full examples](#full-examples)
- [Architecture](#architecture)
- [Local development](#local-development)

---

## Quick start

```bash
# 1. create a room, get a code
curl -X POST https://your-app.onrender.com/api/rooms \
  -H 'content-type: application/json' \
  -d '{"name":"Deploy party","username":"ada"}'
# { "ok": true, "code": "K7P2QX", "room": { ... }, "join": { "websocket": "wss://..." } }

# 2. chat (any WebSocket client)
websocat "wss://your-app.onrender.com/ws?room=K7P2QX&username=ada"
> {"type":"message","text":"hello world"}
```

Browser:

```js
const ws = new WebSocket("wss://your-app.onrender.com/ws?room=K7P2QX&username=ada");
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({ type: "message", text: "hello world" }));
```

---

## Deploy to Render (free tier)

The repo contains a `render.yaml` blueprint (free web service + free Postgres).

**Blueprint deploy**

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo → **Apply**.
3. Render creates the web service and the database and wires `DATABASE_URL` automatically.

**Manual deploy**

1. **New → Web Service** → connect the repo (runtime: **Node**).
2. Build command: `npm install && npm run build`
3. Start command: `npm start`
4. **New → PostgreSQL** (free) and copy its *Internal Database URL*.
5. Add env var `DATABASE_URL` = that URL, then deploy.

Notes for the free tier:

* WebSockets are supported on free web services — no extra config needed.
* Only **one port** is exposed (`$PORT`), which is exactly why the WebSocket server is mounted on
  the same HTTP server instead of a separate port.
* Free instances **sleep after ~15 min of inactivity**; the first request (and the first WS
  handshake) after a sleep takes a few seconds. The client in this repo retries automatically.
* Tables are created automatically at boot (`server/ensure-schema.mjs`), so no migration step is
  required on first deploy.

---

## REST API

All endpoints return JSON, send `Access-Control-Allow-Origin: *` (usable from any origin), and use
this error envelope:

```json
{ "ok": false, "error": { "code": "USERNAME_TAKEN", "message": "…" } }
```

### POST /api/rooms

Create a room and receive its join code.

**Body** (all optional)

| field | type | default | notes |
|---|---|---|---|
| `name` | string | `"<username>'s room"` | max 80 chars |
| `topic` | string | `null` | max 200 chars |
| `username` | string | `null` | recorded as the creator; does **not** join the room |
| `maxMembers` | number | `50` | clamped to 2…200 |

```bash
curl -X POST https://your-app.onrender.com/api/rooms \
  -H 'content-type: application/json' \
  -d '{"name":"Deploy party","topic":"ship it","username":"ada","maxMembers":20}'
```

**201 Created**

```json
{
  "ok": true,
  "code": "K7P2QX",
  "room": {
    "code": "K7P2QX",
    "name": "Deploy party",
    "topic": "ship it",
    "maxMembers": 20,
    "createdAt": "2026-01-01T10:00:00.000Z",
    "lastActivityAt": "2026-01-01T10:00:00.000Z"
  },
  "join": {
    "websocket": "wss://your-app.onrender.com/ws?room=K7P2QX&username=YOUR_NAME",
    "websocketRoomPath": "wss://your-app.onrender.com/api/rooms/K7P2QX/ws?username=YOUR_NAME",
    "http": "https://your-app.onrender.com/api/rooms/K7P2QX/join",
    "web": "https://your-app.onrender.com/?room=K7P2QX"
  }
}
```

Room codes are 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no look-alikes) and are
case-insensitive everywhere.

### GET /api/rooms

List recently active rooms. Query: `?limit=20` (max 100).

```json
{ "ok": true, "count": 1,
  "rooms": [{ "code": "K7P2QX", "name": "Deploy party", "topic": "ship it",
              "members": 3, "maxMembers": 20,
              "createdAt": "…", "lastActivityAt": "…" }] }
```

### GET /api/rooms/:code

Room metadata plus the live roster. `404 ROOM_NOT_FOUND` if the code is unknown.

```json
{ "ok": true,
  "room": { "code": "K7P2QX", "name": "Deploy party", "topic": "ship it", "maxMembers": 20 },
  "memberCount": 2,
  "members": [
    { "username": "ada", "transport": "ws", "joinedAt": "…", "lastSeenAt": "…" },
    { "username": "bob", "transport": "http", "joinedAt": "…", "lastSeenAt": "…" }
  ],
  "join": { "websocket": "wss://…/ws?room=K7P2QX&username=YOUR_NAME" } }
```

### POST /api/rooms/:code/join

Claim a username **without** using a WebSocket (HTTP polling clients, bots, CI checks).

**Body:** `{ "username": "ada", "sessionId": "optional-uuid", "history": 50 }`

```bash
curl -X POST https://your-app.onrender.com/api/rooms/K7P2QX/join \
  -H 'content-type: application/json' -d '{"username":"ada"}'
```

**200 OK**

```json
{ "ok": true, "status": "joined",
  "room": { "code": "K7P2QX", "name": "Deploy party" },
  "username": "ada",
  "sessionId": "6f1f…",        // keep this: needed for messages/presence/leave
  "members": [ … ],
  "history": [ … ],
  "cursor": 42,
  "endpoints": { "websocket": "wss://…", "messages": "…", "presence": "…", "leave": "…" } }
```

| status | meaning |
|---|---|
| `400 INVALID_USERNAME` | fails the username rules |
| `404 ROOM_NOT_FOUND` | bad code |
| `409 USERNAME_TAKEN` | **somebody with that name is already in the room** |
| `403 ROOM_FULL` | `maxMembers` reached |

Re-sending the same `sessionId` is treated as a reconnect and always succeeds.

### POST /api/rooms/:code/messages

Send a message over plain HTTP. Delivered to every live WebSocket client in the room.

**Body:** `{ "username": "ada", "text": "hi", "sessionId": "6f1f…" }`
(`sessionId` is optional; when supplied it is validated and refreshes your presence.)

```json
{ "ok": true,
  "message": { "id": 43, "room": "K7P2QX", "username": "ada", "body": "hi",
               "kind": "chat", "createdAt": "2026-01-01T10:02:00.000Z" } }
```

### GET /api/rooms/:code/messages

Poll history. Query: `after=<id>` (ascending, for polling), `before=<id>` (older page),
`limit=<1..200>` (default 50).

```bash
curl "https://your-app.onrender.com/api/rooms/K7P2QX/messages?after=0&limit=50"
```

```json
{ "ok": true, "room": "K7P2QX", "count": 2, "cursor": 43, "messages": [ … ] }
```

Use the returned `cursor` as the next `after` value.

### POST /api/rooms/:code/presence

Heartbeat for HTTP clients — **call at least every 30 s** or the username is released.
`GET` on the same path returns the roster without a heartbeat.

**Body:** `{ "username": "ada", "sessionId": "6f1f…" }` → `{ "ok": true, "members": [ … ] }`
Returns `409 SESSION_EXPIRED` if you were reaped; just call `/join` again.

### POST /api/rooms/:code/leave

**Body:** `{ "username": "ada", "sessionId": "6f1f…" }` → frees the username immediately and posts a
`… left the room` system message.

### GET /api/health

```json
{ "ok": true, "service": "render-chat", "database": "up",
  "websocket": { "enabled": true, "url": "wss://…/ws", "sockets": 4, "rooms": 2, "messages": 118 } }
```

---

## WebSocket API

### Connecting

Every one of these paths is accepted:

```
wss://your-app.onrender.com/                       ← bare host
wss://your-app.onrender.com/ws
wss://your-app.onrender.com/ws/K7P2QX
wss://your-app.onrender.com/api/rooms/K7P2QX/ws
```

Query parameters (optional — you can send a `join` frame instead):

| param | notes |
|---|---|
| `room` | the room code |
| `username` | your display name, unique per room |
| `sessionId` | pass the previous value to resume a session after a drop |

If `room` **and** `username` are present the server joins you automatically right after the
`welcome` frame. All frames are JSON text, max 64 KB.

### Client → server frames

```jsonc
{ "type": "join",    "room": "K7P2QX", "username": "ada", "sessionId": "…", "history": 50 }
{ "type": "message", "text": "hello world", "nonce": "optional-client-id" }
{ "type": "typing",  "isTyping": true }
{ "type": "history", "limit": 50, "before": 120 }   // older page of messages
{ "type": "members" }                                // ask for the roster
{ "type": "ping",    "t": 1730000000 }               // → {"type":"pong"}
{ "type": "leave" }                                  // release the username, keep socket open
```

`text`, `body`, `message` and `content` are all accepted as the message field.
Rate limit: **15 messages / 10 s** per socket → `error` frame with code `RATE_LIMITED`.

### Server → client frames

```jsonc
// immediately on connect
{ "type": "welcome", "protocol": 1, "hub": "…", "connectionId": "…",
  "serverTime": "…", "maxMessageLength": 2000, "presenceTtlSeconds": 45 }

// after a successful join
{ "type": "joined", "status": "joined" | "rejoined",
  "room": { "code": "K7P2QX", "name": "Deploy party", "topic": "ship it", "maxMembers": 20 },
  "username": "ada", "sessionId": "6f1f…",
  "members": [{ "username": "bob", "transport": "ws", "joinedAt": "…", "lastSeenAt": "…" }],
  "history": [ { "id": 1, "username": "bob", "body": "hey", "kind": "chat", "createdAt": "…" } ] }

// every chat or system line ("kind" is "chat" or "system")
{ "type": "message", "id": 44, "room": "K7P2QX", "username": "ada",
  "body": "hello world", "kind": "chat", "createdAt": "…" }

// roster changes ("join" | "leave" | "timeout")
{ "type": "presence", "event": "join", "room": "K7P2QX", "username": "bob", "members": [ … ] }

{ "type": "typing",  "room": "K7P2QX", "username": "bob", "isTyping": true }
{ "type": "history", "room": "K7P2QX", "messages": [ … ] }
{ "type": "members", "room": "K7P2QX", "members": [ … ] }
{ "type": "ack",     "nonce": "client-id", "id": 44 }   // only if you sent a nonce
{ "type": "pong",    "t": 1730000000 }
{ "type": "left",    "ok": true }
{ "type": "error",   "code": "USERNAME_TAKEN", "message": "…" }
```

**Error codes:** `INVALID_JSON`, `INVALID_FRAME`, `UNKNOWN_TYPE`, `INVALID_ROOM`,
`INVALID_USERNAME`, `ROOM_NOT_FOUND`, `ROOM_LOCKED`, `ROOM_FULL`, `USERNAME_TAKEN`,
`ALREADY_JOINED`, `JOIN_REQUIRED`, `EMPTY_MESSAGE`, `RATE_LIMITED`, `SERVER_ERROR`.

### Close codes

| code | meaning |
|---|---|
| `4400` | malformed request |
| `4401` | you must join before chatting |
| `4403` | room full |
| `4404` | room not found |
| `4409` | **username already in the room** |
| `4429` | rate limited |
| `1001` | normal leave / server shutting down |

The server pings every 20 s; reply with a pong (browsers and `ws` do this automatically) or the
socket is terminated.

---

## Username rules

* 2–32 characters, letters / digits / space / `.` / `-` / `_`, must start and end alphanumeric.
* **Unique per room, case-insensitive.** `Ada` and `ada` collide.
* Claiming is atomic (`INSERT … ON CONFLICT` against a unique index), so two simultaneous joins
  can never both win.
* A name is released when: the socket closes, `{"type":"leave"}` / `POST /leave` is called, or the
  member's last heartbeat is older than **45 s**.
* Reconnecting with the **same `sessionId`** always reclaims your own name.

```jsonc
// websocket
{ "type": "error", "code": "USERNAME_TAKEN",
  "message": "the username \"ada\" is already in room K7P2QX" }   // then close 4409

// http
HTTP/1.1 409 Conflict
{ "ok": false, "error": { "code": "USERNAME_TAKEN", "message": "…" } }
```

---

## Full examples

### Node.js bot (`ws`)

```js
import WebSocket from "ws";

const res = await fetch("https://your-app.onrender.com/api/rooms", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Bot lounge", username: "botmaster" }),
});
const { code } = await res.json();

const ws = new WebSocket(`wss://your-app.onrender.com/ws?room=${code}&username=echo-bot`);

ws.on("message", (raw) => {
  const frame = JSON.parse(raw);
  if (frame.type === "error") return console.error(frame.code, frame.message);
  if (frame.type === "message" && frame.kind === "chat" && frame.username !== "echo-bot") {
    ws.send(JSON.stringify({ type: "message", text: `you said: ${frame.body}` }));
  }
});
```

A ready-to-run version lives in [`examples/node-client.mjs`](examples/node-client.mjs):

```bash
node examples/node-client.mjs --url wss://your-app.onrender.com --room K7P2QX --user ada
node examples/node-client.mjs --url wss://your-app.onrender.com --create --user ada
```

### Pure HTTP client (no WebSocket)

```bash
CODE=K7P2QX
SESSION=$(curl -s -X POST https://your-app.onrender.com/api/rooms/$CODE/join \
  -H 'content-type: application/json' -d '{"username":"ada"}' | jq -r .sessionId)

curl -X POST https://your-app.onrender.com/api/rooms/$CODE/messages \
  -H 'content-type: application/json' \
  -d "{\"username\":\"ada\",\"sessionId\":\"$SESSION\",\"text\":\"hi from curl\"}"

# poll
curl "https://your-app.onrender.com/api/rooms/$CODE/messages?after=0"

# keep the name (every <30s) and finally release it
curl -X POST https://your-app.onrender.com/api/rooms/$CODE/presence \
  -H 'content-type: application/json' -d "{\"username\":\"ada\",\"sessionId\":\"$SESSION\"}"
curl -X POST https://your-app.onrender.com/api/rooms/$CODE/leave \
  -H 'content-type: application/json' -d "{\"username\":\"ada\",\"sessionId\":\"$SESSION\"}"
```

### Python (`websockets`)

```python
import asyncio, json, websockets

async def main():
    url = "wss://your-app.onrender.com/ws"
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "join", "room": "K7P2QX", "username": "ada"}))
        async for raw in ws:
            frame = json.loads(raw)
            print(frame)
            if frame["type"] == "joined":
                await ws.send(json.dumps({"type": "message", "text": "hi from python"}))

asyncio.run(main())
```

---

## Architecture

```
                         one Render web service, one port
┌──────────────────────────────────────────────────────────────────┐
│ server.mjs  (node http.Server)                                    │
│   ├── HTTP  ──► Next.js request handler ──► React UI + /api/*     │
│   └── UPGRADE ─► ws.WebSocketServer (server/chat-hub.mjs)         │
│                    • join / message / typing / presence           │
│                    • per-room socket registry, 20s ping           │
└───────────┬──────────────────────────────────────────┬────────────┘
            │ Drizzle ORM                              │ pg NOTIFY/LISTEN
            ▼                                          ▼
      PostgreSQL: rooms · messages · room_members  (chat_events channel)
```

* **`server.mjs`** – custom Node server. Serves Next.js *and* handles WebSocket upgrades on `/`,
  `/ws`, `/ws/:code`, `/api/rooms/:code/ws`; forwards `/_next/*` upgrades to Next's HMR handler.
* **`server/chat-hub.mjs`** – the WebSocket hub: room registry, presence, rate limiting,
  heartbeats, history, Postgres `LISTEN chat_events` fan-in.
* **REST routes** publish with `pg_notify('chat_events', …)`, so a message posted over HTTP shows up
  instantly in every open socket (and keeps working if you ever scale to more than one instance).
* **Presence table** (`room_members`) with a unique index on `(room_code, username_key)` is what
  makes "username already taken" airtight across both transports.
* **Client fallback** – the browser client tries WebSocket 3×; if the handshake keeps failing it
  transparently degrades to `/join` + polling `/messages?after=` + presence heartbeats.

Schema (`src/db/schema.ts`):

| table | purpose |
|---|---|
| `rooms` | `code` (unique join code), `name`, `topic`, `max_members`, `last_activity_at` |
| `messages` | persisted history, `kind` = `chat` \| `system` |
| `room_members` | live presence, unique on `(room_code, username_key)`, `last_seen_at` TTL 45 s |

---

## Local development

```bash
npm install
cp .env.example .env          # point DATABASE_URL at your Postgres
npm run db:push               # optional – tables are also created on boot
npm run dev                   # custom server, http://localhost:3000
```

```bash
npm run build && npm start    # production mode
node scripts/smoke-test.mjs http://127.0.0.1:3000   # 14-check end-to-end suite
```

| script | what it does |
|---|---|
| `npm run dev` | custom server (Next dev + WebSocket hub) |
| `npm run build` | `next build` |
| `npm start` | production custom server on `$PORT` |
| `npm run db:push` | apply `src/db/schema.ts` with drizzle-kit |
| `npm run typecheck` | `tsc --noEmit` |

**Environment variables**

| name | required | notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string |
| `PORT` | – | provided by Render, defaults to `3000` |
| `HOST` | – | defaults to `0.0.0.0` |
| `DATABASE_SSL` | – | set to `true` to force TLS (also auto-detected from `sslmode=require`) |

MIT licensed — do what you like with it.
