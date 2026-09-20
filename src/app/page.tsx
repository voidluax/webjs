import ApiDocs from "@/components/ApiDocs";
import ChatApp from "@/components/ChatApp";

export default function Home() {
  return (
    <main className="min-h-screen bg-[radial-gradient(60rem_40rem_at_50%_-10%,rgba(99,102,241,0.25),transparent),radial-gradient(40rem_30rem_at_90%_10%,rgba(16,185,129,0.15),transparent)] px-4 py-10">
      <div className="mx-auto mb-10 max-w-6xl text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          one process · HTTP + WebSocket on the same port · Render free tier ready
        </span>
        <h1 className="mt-5 bg-gradient-to-b from-white to-slate-400 bg-clip-text text-4xl font-black tracking-tight text-transparent sm:text-6xl">
          Render Chat
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-balance text-slate-400">
          A room-code chat app with its own WebSocket server. Create a room over REST, get a code,
          then connect to <code className="text-emerald-300">wss://your-app.onrender.com</code> and
          talk. Usernames are unique per room — duplicates are rejected by the server.
        </p>
      </div>

      <ChatApp />

      <div className="mx-auto my-14 max-w-6xl">
        <div className="mb-6 flex items-center gap-4">
          <h2 className="text-xl font-bold text-slate-200">API & WebSocket documentation</h2>
          <span className="h-px flex-1 bg-white/10" />
          <a
            href="https://github.com"
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            see README.md
          </a>
        </div>
        <ApiDocs />
      </div>

      <footer className="pb-8 text-center text-xs text-slate-600">
        Next.js · custom Node WebSocket server (ws) · PostgreSQL + Drizzle · NOTIFY/LISTEN fan-out
      </footer>
    </main>
  );
}
