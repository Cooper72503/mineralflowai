import Link from "next/link";

type PublicFooterProps = {
  variant?: "default" | "landing";
};

export function PublicFooter({ variant = "default" }: PublicFooterProps) {
  if (variant !== "landing") {
    return null;
  }

  return (
    <footer className="public-footer public-footer--landing">
      <div className="public-footer-inner">
        <span className="public-footer-brand">Mineral Flow AI</span>
        <nav className="public-footer-nav" aria-label="Footer">
          <Link href="/pricing">Pricing</Link>
          <Link href="/about">About</Link>
          <Link href="/login">Log in</Link>
          <Link href="/signup">Sign up</Link>
        </nav>
        <p className="public-footer-copy">
          © {new Date().getFullYear()} Mineral Flow AI. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
