"use client";

import { useState } from "react";
import { Menu, Zap } from "lucide-react";
import { Sidebar } from "./sidebar";
import { cn } from "@/lib/utils";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Backdrop — only on mobile when the drawer is open */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar: off-canvas drawer on mobile, static panel on desktop */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <Sidebar onNavigate={() => setOpen(false)} />
      </div>

      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar with hamburger toggle (hidden on desktop) */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-4 md:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Menu className="h-6 w-6" />
          </button>
          <Zap className="h-5 w-5 text-primary" />
          <span className="font-bold">Lead Finder</span>
        </header>

        <div className="flex-1 overflow-y-auto bg-background">
          <div className="container mx-auto max-w-7xl p-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
