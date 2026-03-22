import { PublicHeader } from "../components/PublicHeader";

export default function AboutPage() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main">
        <h1>About</h1>
        <p className="public-tagline">
          Mineral Intelligence AI helps mineral buyers, landmen, and acquisition teams find opportunities near drilling activity.
        </p>
        <div className="card" style={{ maxWidth: 560, marginTop: "1.5rem", textAlign: "left" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.75rem" }}>
            Our mission
          </h2>
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            We combine public records, document extraction, and mapping to surface mineral ownership opportunities and streamline due diligence.
          </p>
        </div>
      </main>
    </div>
  );
}
