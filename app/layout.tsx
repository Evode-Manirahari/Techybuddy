import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { AppShell } from "../src/components/shell";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap", fallback: ["system-ui", "Segoe UI", "Helvetica Neue", "sans-serif"] });

export const metadata: Metadata = {
  title: "Techybuddy",
  description: "Voice-first assistant for HVAC and plumbing technicians.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
