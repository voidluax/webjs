#!/usr/bin/env node
/**
 * Terminal chat client for the Render Chat websocket server.
 *
 *   node examples/node-client.mjs --url wss://your-app.onrender.com --room K7P2QX --user ada
 *   node examples/node-client.mjs --url http://localhost:3000 --create --user ada
 *
 * Flags:
 *   --url    base URL (http(s):// or ws(s)://). default http://127.0.0.1:3000
 *   --room   room code to join
 *   --create create a new room first and print the code
 *   --user   your username (must be unique in the room)
 *   --name   room name when using --create
 */
import readline from "node:readline";
import WebSocket from "ws";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) args.set(key, "true");
  else {
    args.set(key, next);
    i += 1;
  }
}

const rawUrl = args.get("url") ?? "http://127.0.0.1:3000";
const httpBase = rawUrl.replace(/^ws/, "http").replace(/\/+$/, "");
const wsBase = httpBase.replace(/^http/, "ws");
const username = args.get("user") ?? `guest-${Math.floor(Math.random() * 900 + 100)}`;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function resolveRoom() {
  if (args.get("create") === "true") {
    const res = await fetch(`${httpBase}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: args.get("name") ?? `${username}'s room`, username }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? "could not create room");
    console.log(C.green(`\n  room created → share this code: ${C.bold(data.code)}\n`));
    return data.code;
  }
  const code = args.get("room");
  if (!code) throw new Error("pass --room CODE or --create");
  return code.toUpperCase();
}

const room = await resolveRoom();
const url = `${wsBase}/ws?room=${encodeURIComponent(room)}&username=${encodeURIComponent(username)}`;
console.log(C.dim(`connecting to ${url}`));

const ws = new WebSocket(url);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

ws.on("open", () => console.log(C.dim("socket open, waiting for join…")));

ws.on("message", (raw) => {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (frame.type) {
    case "welcome":
      break;
    case "joined": {
      console.log(
        C.green(`joined ${frame.room.name} (${frame.room.code}) as ${frame.username}`),
      );
      console.log(C.dim(`members: ${frame.members.map((m) => m.username).join(", ")}`));
      for (const message of frame.history.slice(-15)) print(message);
      rl.prompt();
      break;
    }
    case "message":
      print(frame);
      rl.prompt();
      break;
    case "presence":
      console.log(C.dim(`* ${frame.username} ${frame.event} — ${frame.members.length} online`));
      rl.prompt();
      break;
    case "error":
      console.log(C.red(`! ${frame.code}: ${frame.message}`));
      break;
    default:
      break;
  }
});

function print(message) {
  const time = new Date(message.createdAt).toLocaleTimeString();
  if (message.kind === "system") {
    console.log(C.dim(`  ${time}  * ${message.body}`));
    return;
  }
  console.log(`  ${C.dim(time)}  ${C.cyan(message.username)}: ${message.body}`);
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === "/quit") {
    ws.send(JSON.stringify({ type: "leave" }));
    ws.close();
    rl.close();
    return;
  }
  if (text === "/members") {
    ws.send(JSON.stringify({ type: "members" }));
    return;
  }
  ws.send(JSON.stringify({ type: "message", text }));
  rl.prompt();
});

ws.on("close", (code, reason) => {
  console.log(C.red(`\nsocket closed (${code}) ${reason?.toString() ?? ""}`));
  rl.close();
  process.exit(code === 1000 ? 0 : 1);
});

ws.on("error", (error) => console.log(C.red(`socket error: ${error.message}`)));
