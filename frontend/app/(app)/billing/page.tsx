export const dynamic = "force-dynamic";

export default function BillingPage() {
  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Billing</h1>
        <p>Manage your subscription and payment methods</p>
      </div>
      <div className="card" style={{ maxWidth: 560 }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Billing &amp; subscription
        </h2>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          Billing and subscription management will appear here once connected.
        </p>
      </div>
    </div>
  );
}
