"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

function Logo() {
  return (
    <Link href="/" className="flex min-h-11 items-center gap-2.5 text-lg font-semibold tracking-tight" aria-label="Techybuddy home">
      <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-amber text-lg font-bold text-amber-ink" aria-hidden="true">
        T
      </span>
      Techybuddy
    </Link>
  );
}

const links = [
  { href: "/", label: "Jobs", match: (path: string) => path === "/" || (path.startsWith("/jobs/") && path !== "/jobs/new") },
  { href: "/jobs/new", label: "New job", match: (path: string) => path === "/jobs/new" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]">
      <aside className="hidden border-r border-line bg-surface md:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 px-4 py-5">
          <Logo />
          <nav aria-label="Main" className="flex flex-col gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={link.match(path) ? "page" : undefined}
                className={`flex min-h-11 items-center rounded-[13px] px-3 text-base font-semibold ${link.match(path) ? "bg-ink text-white" : "text-muted hover:bg-surface-2"}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur md:hidden">
          <Logo />
          <nav aria-label="Main" className="flex gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={link.match(path) ? "page" : undefined}
                className={`flex min-h-11 items-center rounded-[12px] px-3 text-base font-semibold ${link.match(path) ? "bg-ink text-white" : "text-muted"}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
