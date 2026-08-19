"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import {
  logoutAdminAction,
  setAgentEnabledAction,
  type AdminActionState,
} from "@/app/admin/actions";
import { ThemeToggle } from "@/app/admin/theme-toggle";

const initialState: AdminActionState = { ok: false };

export function AdminNav(props: {
  active: "dashboard" | "slots" | "knowledge" | "messages";
  agentEnabled: boolean;
  scheduleSummary?: string;
  mauritiusNow?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [agentState, agentAction, agentPending] = useActionState(
    setAgentEnabledAction,
    initialState,
  );


  useEffect(() => {
    if (agentState.ok) router.refresh();
  }, [agentState.ok, router]);

  const navItems = [
    {
      key: "dashboard",
      label: "Dashboard",
      href: "/admin",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="7" height="9" x="3" y="3" rx="1" />
          <rect width="7" height="5" x="14" y="3" rx="1" />
          <rect width="7" height="9" x="14" y="12" rx="1" />
          <rect width="7" height="5" x="3" y="16" rx="1" />
        </svg>
      ),
    },
    {
      key: "slots",
      label: "Shifts & Slots",
      href: "/admin/slots",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
          <line x1="16" x2="16" y1="2" y2="6" />
          <line x1="8" x2="8" y1="2" y2="6" />
          <line x1="3" x2="21" y1="10" y2="10" />
        </svg>
      ),
    },
    {
      key: "knowledge",
      label: "Agent Knowledge",
      href: "/admin/knowledge",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
          <path d="M6 6h10" />
          <path d="M6 10h10" />
        </svg>
      ),
    },
    {
      key: "messages",
      label: "Live Activity",
      href: "/admin/messages",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
  ];

  return (
    <>
      {/* Top Header Bar */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-[#E8E5DC] dark:border-[#1D2620]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Grabbit Minimal Geometric Logo */}
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] shadow-sm">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-[#6C746E] dark:text-[#8E9690]">
                Grabbit Express
              </span>
              <h2 className="font-display text-lg font-bold text-[#101412] dark:text-[#F6F3EC] leading-tight">
                Dispatch Console
              </h2>
            </div>
          </div>

          {/* Mobile menu toggle */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="sm:hidden p-2 rounded-xl bg-[#EDEAE2] dark:bg-[#171E1A] text-[#101412] dark:text-[#F6F3EC]"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>

        {/* Action Controls Top Bar */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* AI Status Badge & Toggle */}
          <form action={agentAction}>
            <input
              type="hidden"
              name="enabled"
              value={props.agentEnabled ? "false" : "true"}
            />
            <button
              type="submit"
              disabled={agentPending}
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all border shadow-sm ${
                props.agentEnabled
                  ? "bg-[#FFFFFF] dark:bg-[#121714] text-[#101412] dark:text-[#F6F3EC] border-[#7ed957] hover:border-[#6fc847]"
                  : "bg-[#FFFFFF] dark:bg-[#121714] text-[#9b2c2c] border-[#f0c2c2] hover:bg-[#fff5f5]"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  props.agentEnabled ? "bg-[#7ed957] animate-pulse" : "bg-[#9b2c2c]"
                }`}
              />
              <span>{agentPending ? "Updating..." : props.agentEnabled ? "AI Active" : "AI Paused"}</span>
            </button>
          </form>

          {/* Theme Toggle */}
          <ThemeToggle />

          {/* Logout Action */}
          <form action={logoutAdminAction}>
            <button
              type="submit"
              title="Sign Out"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[#EDEAE2] dark:bg-[#171E1A] text-[#6C746E] dark:text-[#8E9690] hover:text-[#101412] dark:hover:text-[#F6F3EC] border border-[#E8E5DC] dark:border-[#1D2620] transition-colors"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </form>
        </div>
      </header>

      {/* Navigation Pills Bar */}
      <nav className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
        {navItems.map((item) => {
          const isActive = props.active === item.key || (item.key === "dashboard" && pathname === "/admin");
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold transition-all whitespace-nowrap ${
                isActive
                  ? "bg-[#101412] dark:bg-[#F6F3EC] text-white dark:text-[#101412] shadow-sm"
                  : "bg-transparent text-[#6C746E] dark:text-[#8E9690] hover:text-[#101412] dark:hover:text-[#F6F3EC] hover:bg-[#EDEAE2] dark:hover:bg-[#171E1A]"
              }`}
            >
              <span className={isActive ? "text-[#7ed957] dark:text-[#7ed957]" : ""}>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
