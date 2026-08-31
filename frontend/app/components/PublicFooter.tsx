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
        <span className="public-footer-brand">MineralFlow AI</span>
        <nav className="public-footer-nav" aria-label="Footer">
          <Link href="/pricing">Request Access</Link>
          <Link href="/about">About</Link>
          <Link href="/login">Log in</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
        <p className="public-footer-copy">
          © {new Date().getFullYear()} MineralFlow AI. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
