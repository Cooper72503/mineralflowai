"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";

// ── Icons ──────────────────────────────────────────────────────────────────
function IconDashboard() {
  return (
    <svg className="sidebar-nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1.25"/>
      <rect x="9.5" y="1.5" width="5" height="5" rx="1.25"/>
      <rect x="1.5" y="9.5" width="5" height="5" rx="1.25"/>
      <rect x="9.5" y="9.5" width="5" height="5" rx="1.25"/>
    </svg>
  );
}
function IconDueDiligence() {
  return (
    <svg className="sidebar-nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>
      <path d="M10 2v3h3"/>
      <path d="M5.5 7.5h5M5.5 10h3"/>
      <circle cx="11" cy="11" r="2" stroke="currentColor"/>
      <path d="M12.5 12.5L14 14"/>
    </svg>
  );
}
function IconSettings() {
  return (
    <svg className="sidebar-nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.25"/>
      <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>
    </svg>
  );
}
function IconBilling() {
  return (
    <svg className="sidebar-nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="3.5" width="14" height="9" rx="1.75"/>
      <path d="M1 7h14"/>
      <path d="M4 10.5h3" strokeWidth="1.75"/>
    </svg>
  );
}
function IconSignOut() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>
      <path d="M10.5 11L14 8l-3.5-3"/>
      <path d="M14 8H6"/>
    </svg>
  );
}
function IconBrandMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 1L14 5v6L8 15 2 11V5L8 1z" fill="rgba(255,255,255,0.9)" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5"/>
      <path d="M8 4L12 6.5v3L8 12 4 9.5v-3L8 4z" fill="rgba(96,165,250,0.8)"/>
    </svg>
  );
}

// ── Nav config ─────────────────────────────────────────────────────────────
const primaryNav = [
  { href: "/trrc-due-diligence", label: "TRRC Due Diligence", Icon: IconDueDiligence },
] as const;

const accountNav = [
  { href: "/settings",     label: "Settings",                 Icon: IconSettings     },
  { href: "/billing",      label: "Billing",                  Icon: IconBilling      },
] as const;

// ── SignOut (inside sidebar) ───────────────────────────────────────────────
function SidebarSignOut() {
  const [loading, setLoading] = useState(false);

  function handleSignOut() {
    if (loading) return;
    setLoading(true);
    // Hard navigation bypasses fetch() ByteString validation on corrupted cookies.
    // /api/auth/signout signs out server-side, expires all auth cookies, then redirects to /login.
    window.location.href = "/api/auth/signout";
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={loading}
      className="sidebar-signout"
    >
      <IconSignOut />
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}

// ── Nav section renderer ───────────────────────────────────────────────────
function NavGroup({
  items,
  pathname,
  onClose,
}: {
  items: ReadonlyArray<{ href: string; label: string; Icon: () => JSX.Element }>;
  pathname: string;
  onClose?: () => void;
}) {
  return (
    <>
      {items.map(({ href, label, Icon }) => {
        const isActive = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            className={isActive ? "active" : undefined}
            onClick={onClose}
          >
            <Icon />
            {label}
          </Link>
        );
      })}
    </>
  );
}

// ── Main Sidebar ───────────────────────────────────────────────────────────
export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  const brandEl = (
    <div className="sidebar-brand">
      <Link href="/dashboard">
        <span className="sidebar-brand-logo"><IconBrandMark /></span>
        MineralFlow AI
      </Link>
    </div>
  );

  const navEl = (close?: () => void) => (
    <nav className="sidebar-nav">
      <NavGroup items={primaryNav} pathname={pathname} onClose={close} />
      <div className="sidebar-section-label">Account</div>
      <NavGroup items={accountNav} pathname={pathname} onClose={close} />
    </nav>
  );

  const footerEl = (
    <div className="sidebar-footer">
      <SidebarSignOut />
    </div>
  );

  return (
    <>
      {/* ── Desktop sidebar ── */}
      <aside className="sidebar sidebar-desktop">
        {brandEl}
        {navEl()}
        {footerEl}
      </aside>

      {/* ── Mobile top bar ── */}
      <div className="mobile-topbar">
        <Link href="/dashboard" className="mobile-topbar-brand">
          MineralFlow AI
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

      {/* ── Mobile drawer ── */}
      {mobileOpen && (
        <div className="mobile-overlay" onClick={() => setMobileOpen(false)} aria-hidden />
      )}
      <aside className={`sidebar sidebar-mobile${mobileOpen ? " open" : ""}`}>
        {brandEl}
        {navEl(() => setMobileOpen(false))}
        {footerEl}
      </aside>
    </>
  );
}
