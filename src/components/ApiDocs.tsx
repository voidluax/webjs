"use client";

import { useEffect, useState } from "react";

const SECTIONS = [
  {
    id: "rest",
    title: "REST API",
    rows: [
      ["POST", "/api/rooms", "Create a room, returns the join code"],
      ["GET", "/api/rooms", "List recently active rooms"],
      ["GET", "/api/rooms/:code", "Room metadata + live member roster"],
      ["POST", "/api/rooms/:code/join", "Claim a username (409 if taken)"],
      ["POST", "/api/rooms/:code/messages", "Send a message over HTTP"],
      ["GET", "/api/rooms/:code/messages?after=<id>", "Poll for new messages"],
      ["POST", "/api/rooms/:code/presence", "Heartbeat (keeps the username held)"],
      ["POST", "/api/rooms/:code/leave", "Release the username"],
      ["GET", "/api/health", "Health + websocket hub stats"],
    ],
  },
];

export default function ApiDocs() {
  const [host, setHost] = useState("your-app.onrender.com");
  const [secure, setSecure] = useState(true);

  useEffect(() => {
    setHost(window.location.host);
    setSecure(window.location.protocol === "https:");
  }, []);

  const wsBase = `${secure ? "wss" : "ws"}://${host}`;
  const httpBase = `${secure ? "https" : "http"}://${host}`;

  return (
    <section className="mx-auto w-full max-w-6xl space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur">
          <h3 className="mb-1 text-lg font-semibold text-slate-100">1 · Make a room</h3>
          <p className="mb-4 text-sm text-slate-400">
            Any HTTP client can create a room. The response contains the code people use to join.
          </p>
          <pre className="overflow-x-auto rounded-xl bg-slate-950/80 p-4 text-xs leading-relaxed text-slate-300">
{`curl -X POST ${httpBase}/api/rooms \\
  -H 'content-type: application/json' \\
  -d '{"name":"Deploy party","username":"ada"}'

# → { "ok": true, "code": "K7P2QX", "room": { ... } }`}
          </pre>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur">
          <h3 className="mb-1 text-lg font-semibold text-slate-100">2 · Chat over WebSocket</h3>
          <p className="mb-4 text-sm text-slate-400">
            Same host, same port. Pass the code + username in the query string or send a{" "}
            <code className="text-indigo-300">join</code> frame.
          </p>
          <pre className="overflow-x-auto rounded-xl bg-slate-950/80 p-4 text-xs leading-relaxed text-slate-300">
{`const ws = new WebSocket(
  "${wsBase}/ws?room=K7P2QX&username=ada"
);

ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({
  type: "message", text: "hello world"
}));`}
          </pre>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur">
          {SECTIONS.map((section) => (
            <div key={section.id}>
              <h3 className="mb-4 text-lg font-semibold text-slate-100">{section.title}</h3>
              <ul className="divide-y divide-white/5 text-sm">
                {section.rows.map(([method, path, description]) => (
                  <li key={`${method}${path}`} className="flex flex-wrap items-center gap-3 py-2">
                    <span
                      className={`w-14 shrink-0 rounded px-2 py-0.5 text-center font-mono text-[11px] font-bold ${
                        method === "GET"
                          ? "bg-sky-500/15 text-sky-300"
                          : "bg-emerald-500/15 text-emerald-300"
                      }`}
                    >
                      {method}
                    </span>
                    <code className="font-mono text-xs text-slate-200">{path}</code>
                    <span className="ml-auto text-xs text-slate-500">{description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 backdrop-blur">
            <h3 className="mb-3 text-lg font-semibold text-slate-100">WebSocket frames</h3>
            <div className="space-y-2 text-xs">
              {[
                ['{"type":"join","room":"K7P2QX","username":"ada"}', "client → server"],
                ['{"type":"message","text":"hi"}', "client → server"],
                ['{"type":"typing","isTyping":true}', "client → server"],
                ['{"type":"joined","members":[…],"history":[…]}', "server → client"],
                ['{"type":"message","id":12,"username":"ada",…}', "server → client"],
                ['{"type":"presence","event":"join","members":[…]}', "server → client"],
                ['{"type":"error","code":"USERNAME_TAKEN"}', "server → client"],
              ].map(([frame, dir]) => (
                <div key={frame} className="rounded-lg bg-slate-950/70 px-3 py-2">
                  <code className="block break-all font-mono text-[11px] text-slate-300">
                    {frame}
                  </code>
                  <span className="text-[10px] uppercase tracking-wider text-slate-600">{dir}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-6">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-amber-300">
              Username rule
            </h3>
            <p className="text-sm text-amber-100/80">
              A username can only be held by one connection per room. A duplicate join is refused
              with <code className="text-amber-200">409 USERNAME_TAKEN</code> over HTTP and an{" "}
              <code className="text-amber-200">error</code> frame + close code{" "}
              <code className="text-amber-200">4409</code> over WebSocket. Names free up{" "}
              automatically 45s after the last heartbeat.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
