"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { SignOutButton } from "./SignOutButton";

const navItems = [
  { href: "/dashboard",  label: "Dashboard"       },
  { href: "/pipeline",   label: "Pipeline"         },
  { href: "/screen",     label: "Quick Screen"     },
  { href: "/offer",      label: "Offer Calculator" },
  { href: "/upload",     label: "Upload"           },
  { href: "/documents",  label: "Documents"        },
  { href: "/leads",      label: "Leads"            },
  { href: "/alerts",     label: "Alerts"           },
  { href: "/settings",   label: "Settings"         },
  { href: "/billing",    label: "Billing"          },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Prevent body scroll when mobile nav is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const navLinks = (
    <nav className="sidebar-nav">
      {navItems.map(({ href, label }) => {
        const isActive =
          pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            className={isActive ? "active" : undefined}
            onClick={() => setMobileOpen(false)}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* ── Desktop sidebar ── */}
      <aside className="sidebar sidebar-desktop">
        <div className="sidebar-brand">
          <Link href="/dashboard">Mineral Flow AI</Link>
        </div>
        {navLinks}
        <div className="sidebar-footer">
          <SignOutButton />
        </div>
      </aside>

      {/* ── Mobile top bar ── */}
      <div className="mobile-topbar">
        <Link href="/dashboard" className="mobile-topbar-brand">
          Mineral Flow AI
        </Link>
        <button
          className="mobile-hamburger"
          onClick={() => setMobileOpen((o) => !o)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
        >
          {mobileOpen ? (
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M4 4l14 14M18 4L4 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M3 6h16M3 11h16M3 16h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          )}
        </button>
      </div>

      {/* ── Mobile drawer overlay ── */}
      {mobileOpen && (
        <div
          className="mobile-overlay"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}
      <aside className={`sidebar sidebar-mobile${mobileOpen ? " open" : ""}`}>
        <div className="sidebar-brand" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Link href="/dashboard" onClick={() => setMobileOpen(false)}>Mineral Flow AI</Link>
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280", padding: "0.25rem" }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        {navLinks}
        <div className="sidebar-footer">
          <SignOutButton />
        </div>
      </aside>
    </>
  );
}
