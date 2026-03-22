export default function SettingsPage() {
  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Settings</h1>
        <p>Manage your account and preferences</p>
      </div>
      <div className="card" style={{ maxWidth: 560 }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Account
        </h2>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          Account and preference settings will appear here. Authentication is not fully implemented yet.
        </p>
      </div>
    </div>
  );
}
