import Link from "next/link";

export function PublicHeader() {
  return (
    <header className="public-header">
      <Link href="/" className="public-brand">
        Mineral Intelligence AI
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
