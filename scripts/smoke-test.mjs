/**
 * End-to-end smoke test: REST room creation + websocket chat + duplicate
 * username rejection + HTTP/WS interop. Run with the server already listening:
 *   node scripts/smoke-test.mjs http://127.0.0.1:3000
 */
import WebSocket from "ws";

const base = process.argv[2] ?? "http://127.0.0.1:3000";
const wsBase = base.replace(/^http/, "ws");
const results = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function waitFor(ws, predicate, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeout);
    const onMessage = (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(frame);
      }
    };
    ws.on("message", onMessage);
  });
}

async function main() {
  // 1. health
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  check("GET /api/health", health.ok === true, `ws enabled=${health.websocket?.enabled}`);
  check("websocket hub mounted", health.websocket?.enabled === true);

  // 2. create room
  const created = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Smoke room", topic: "testing", username: "ada" }),
  }).then((r) => r.json());
  const code = created.code;
  check("POST /api/rooms returns a code", typeof code === "string" && code.length >= 6, code);

  // 3. websocket join
  const alice = new WebSocket(`${wsBase}/ws?room=${code}&username=alice`);
  await new Promise((resolve, reject) => {
    alice.once("open", resolve);
    alice.once("error", reject);
  });
  const joined = await waitFor(alice, (f) => f.type === "joined");
  check("ws join succeeds", joined.room?.code === code, `as ${joined.username}`);

  // 4. duplicate username is rejected
  const clone = new WebSocket(`${wsBase}/ws?room=${code}&username=ALICE`);
  const rejection = await waitFor(clone, (f) => f.type === "error");
  check("duplicate username rejected", rejection.code === "USERNAME_TAKEN", rejection.message);
  const closeCode = await new Promise((resolve) => clone.once("close", (c) => resolve(c)));
  check("duplicate close code is 4409", closeCode === 4409, String(closeCode));

  // 5. second user + broadcast
  const bob = new WebSocket(`${wsBase}/ws?room=${code}&username=bob`);
  await waitFor(bob, (f) => f.type === "joined");
  const presence = await waitFor(alice, (f) => f.type === "presence" && f.event === "join", 4000);
  check("presence broadcast to peers", presence.username === "bob");

  const delivered = waitFor(bob, (f) => f.type === "message" && f.body === "hello bob");
  alice.send(JSON.stringify({ type: "message", text: "hello bob" }));
  const msg = await delivered;
  check("ws message fan-out", msg.username === "alice", msg.body);

  // 6. HTTP -> websocket interop via pg NOTIFY
  const viaHttp = waitFor(alice, (f) => f.type === "message" && f.body === "posted over http", 8000);
  const httpJoin = await fetch(`${base}/api/rooms/${code}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "carol" }),
  }).then((r) => r.json());
  check("HTTP join returns session", typeof httpJoin.sessionId === "string");

  const dupHttp = await fetch(`${base}/api/rooms/${code}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice" }),
  });
  check("HTTP duplicate join is 409", dupHttp.status === 409, String(dupHttp.status));

  await fetch(`${base}/api/rooms/${code}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "carol",
      sessionId: httpJoin.sessionId,
      text: "posted over http",
    }),
  });
  const relayed = await viaHttp;
  check("HTTP message reaches websocket clients", relayed.username === "carol");

  // 7. polling endpoint
  const polled = await fetch(`${base}/api/rooms/${code}/messages?after=0&limit=50`).then((r) =>
    r.json(),
  );
  check("GET messages returns history", polled.messages.length >= 3, `${polled.messages.length} rows`);

  // 8. roster
  const roster = await fetch(`${base}/api/rooms/${code}`).then((r) => r.json());
  check("roster lists 3 members", roster.memberCount === 3, JSON.stringify(roster.members.map((m) => m.username)));

  // 9. leave frees the username
  bob.close();
  await new Promise((r) => setTimeout(r, 600));
  const rejoin = new WebSocket(`${wsBase}/ws?room=${code}&username=bob`);
  const rejoined = await waitFor(rejoin, (f) => f.type === "joined" || f.type === "error");
  check("username freed after leave", rejoined.type === "joined");

  alice.close();
  rejoin.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(1);
});
