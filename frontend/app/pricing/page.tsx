import { PublicHeader } from "../components/PublicHeader";

export default function PricingPage() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main">
        <h1>Pricing</h1>
        <p className="public-tagline">
          Simple, transparent pricing for mineral intelligence.
        </p>
        <div className="card" style={{ maxWidth: 560, marginTop: "1.5rem", textAlign: "left" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.75rem" }}>
            Plans
          </h2>
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            Pricing plans will be listed here. Contact us for enterprise options.
          </p>
        </div>
      </main>
    </div>
  );
}
