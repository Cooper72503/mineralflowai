"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/upload", label: "Upload document" },
  { href: "/documents", label: "Documents" },
  { href: "/leads", label: "Leads" },
  { href: "/alerts", label: "Alerts" },
  { href: "/settings", label: "Settings" },
  { href: "/billing", label: "Billing" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Link href="/dashboard">Mineral Intelligence AI</Link>
      </div>
      <nav className="sidebar-nav">
        {navItems.map(({ href, label }) => {
          const isActive =
            pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={isActive ? "active" : undefined}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <Link href="/login" className="btn btnSecondary" style={{ width: "100%", justifyContent: "center" }}>
          Sign out
        </Link>
      </div>
    </aside>
  );
}
