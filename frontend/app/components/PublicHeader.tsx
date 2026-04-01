import Link from "next/link";

const MAIL_DEMO =
  "mailto:cbosher@mineralflowai.com?subject=Book%20a%20demo%20%E2%80%94%20Mineral%20Flow%20AI";

type PublicHeaderProps = {
  variant?: "default" | "landing";
};

export function PublicHeader({ variant = "default" }: PublicHeaderProps) {
  const landing = variant === "landing";

  if (landing) {
    return (
      <header className="public-header public-header--landing">
        <Link href="/" className="public-brand public-brand--landing">
          Mineral Flow AI
        </Link>
        <nav className="public-nav public-nav--landing" aria-label="Primary">
          <a href="#how-it-works" className="public-nav-quiet">
            How it works
          </a>
          <a href="#product" className="public-nav-quiet">
            Product
          </a>
          <Link href="/pricing">Pricing</Link>
          <Link href="/about">About</Link>
          <Link href="/login">Log in</Link>
          <a href={MAIL_DEMO} className="btn btnLandingPrimary">
            Book a Demo
          </a>
          <Link href="/signup" className="btn btnLandingSecondary">
            Run a Deal
          </Link>
        </nav>
      </header>
    );
  }

  return (
    <header className="public-header">
      <Link href="/" className="public-brand">
        Mineral Flow AI
      </Link>
      <nav className="public-nav">
        <Link href="/pricing">Pricing</Link>
        <Link href="/about">About</Link>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/login">Log in</Link>
        <Link href="/signup" className="btn btnPrimary">
          Sign up
        </Link>
      </nav>
    </header>
  );
}
