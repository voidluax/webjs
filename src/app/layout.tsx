import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Render Chat — WebSocket rooms with join codes",
  description:
    "Room-code chat app with its own WebSocket server (wss://…/ws) and a REST API for creating rooms. Deployable on Render's free tier.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased selection:bg-indigo-500/40">
        {children}
      </body>
    </html>
  );
}
