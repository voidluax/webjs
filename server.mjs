/**
 * Custom Next.js server with a built-in WebSocket hub.
 *
 * Render's free tier gives you exactly one port, so HTTP and WebSocket share
 * it: https://<name>.onrender.com for the REST API / UI and
 * wss://<name>.onrender.com (or /ws) for the realtime chat socket.
 */
import { createServer } from "node:http";
import { config as loadEnv } from "dotenv";
import next from "next";
import pg from "pg";

import { createChatHub } from "./server/chat-hub.mjs";
import { ensureSchema } from "./server/ensure-schema.mjs";

loadEnv({ quiet: true });

const { Pool } = pg;

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("[boot] DATABASE_URL is required");
  process.exit(1);
}

const needsSsl =
  /\bsslmode=require\b/.test(databaseUrl) ||
  (process.env.PGSSLMODE === "require") ||
  (process.env.DATABASE_SSL === "true");

const pool = new Pool({
  connectionString: databaseUrl,
  max: Number.parseInt(process.env.PGPOOL_MAX ?? "8", 10),
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on("error", (error) => console.error("[db] pool error:", error.message));

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
/** @type {((req: any, socket: any, head: any) => void) | null} */
let nextUpgrade = null;

async function main() {
  try {
    await ensureSchema(pool);
  } catch (error) {
    console.error("[db] schema bootstrap failed:", error.message);
  }

  await app.prepare();

  if (typeof app.getUpgradeHandler === "function") {
    try {
      nextUpgrade = app.getUpgradeHandler();
    } catch {
      nextUpgrade = null;
    }
  }

  const hub = createChatHub({ pool, databaseUrl });
  globalThis.__chatHub = hub;

  const server = createServer((req, res) => {
    if (req.url === "/ws" || req.url?.startsWith("/ws?")) {
      // Plain HTTP hit on the socket endpoint: explain how to use it.
      res.writeHead(426, { "Content-Type": "application/json", Upgrade: "websocket" });
      res.end(
        JSON.stringify({
          ok: false,
          error: {
            code: "UPGRADE_REQUIRED",
            message: "connect with a WebSocket client: wss://<host>/ws?room=CODE&username=YOU",
          },
        }),
      );
      return;
    }
    handle(req, res).catch((error) => {
      console.error("[http] handler error:", error);
      res.statusCode = 500;
      res.end("internal server error");
    });
  });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname.startsWith("/_next")) {
      if (nextUpgrade) {
        nextUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
      return;
    }

    const match = hub.matchUpgrade(pathname);
    if (match.matched) {
      hub.handleUpgrade(req, socket, head, match);
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  server.listen(port, hostname, () => {
    console.log(`▲ chat server ready on http://${hostname}:${port} (dev=${dev})`);
    console.log(`   websocket endpoints: /  /ws  /ws/:code  /api/rooms/:code/ws`);
  });

  const shutdown = async (signal) => {
    console.log(`[boot] ${signal} received, shutting down`);
    const timer = setTimeout(() => process.exit(0), 8000);
    try {
      await hub.close();
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    } catch (error) {
      console.error("[boot] shutdown error:", error?.message);
    }
    clearTimeout(timer);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[boot] fatal:", error);
  process.exit(1);
});
