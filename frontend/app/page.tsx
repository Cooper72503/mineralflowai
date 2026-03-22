import Link from "next/link";
import { PublicHeader } from "./components/PublicHeader";

export default function HomePage() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main">
        <h1>Find mineral ownership opportunities near drilling activity</h1>
        <p className="public-tagline">
          For mineral buyers, landmen, and acquisition teams.
        </p>
        <div className="public-actions">
          <Link href="/signup" className="btn btnPrimary">
            Get started
          </Link>
          <Link href="/login" className="btn btnSecondary">
            Log in
          </Link>
        </div>
      </main>
    </div>
  );
}
