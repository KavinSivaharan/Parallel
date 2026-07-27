import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: "Parallel — Multiplayer coding agents",
  description: "The collaboration layer for one live autonomous coding session.",
  openGraph: {
    title: "Parallel — Multiplayer coding agents",
    description: "One execution. Everyone in the room.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Parallel collaboration runtime" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Parallel — Multiplayer coding agents",
    description: "One execution. Everyone in the room.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
