"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

const MIN_SCORE_OPTIONS = [50, 60, 70, 80] as const;

type ExpiringDoc = {
  id: string;
  file_name: string | null;
  county: string | null;
  state: string | null;
  lease_expiration_date: string;
  days_until: number;
};

function daysUntil(dateStr: string): number {
  const exp = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function urgencyStyle(days: number): { background: string; color: string; border: string } {
  if (days <= 7)  return { background: "#fef2f2", color: "#dc2626", border: "#fecaca" };
  if (days <= 30) return { background: "#fff7ed", color: "#d97706", border: "#fed7aa" };
  return              { background: "#eff6ff", color: "#2563eb", border: "#bfdbfe" };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #e5e5e5",
  borderRadius: 6,
};

function formatReturnedError(err: { message?: string; details?: string; hint?: string }): string {
  const message = err.message?.trim() ?? "";
  const details = err.details?.trim() ?? "";
  const hint = err.hint?.trim() ?? "";
  const parts = [message, details && details !== message ? details : "", hint && hint !== message && hint !== details ? hint : ""].filter(
    Boolean,
  );
  return parts.join(" — ");
}

export default function AlertsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [minScore, setMinScore] = useState<number>(50);
  const [county, setCounty] = useState("");
  const [acreageMin, setAcreageMin] = useState("");
  /** Present when this user already has an alerts row (for insert vs update). */
  const [alertRowId, setAlertRowId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [expiringDocs, setExpiringDocs] = useState<ExpiringDoc[]>([]);

  // Load upcoming expirations
  useEffect(() => {
    const in90 = new Date();
    in90.setDate(in90.getDate() + 90);
    supabase
      .from("documents")
      .select("id, file_name, county, state, lease_expiration_date")
      .not("lease_expiration_date", "is", null)
      .gte("lease_expiration_date", new Date().toISOString().slice(0, 10))
      .lte("lease_expiration_date", in90.toISOString().slice(0, 10))
      .order("lease_expiration_date", { ascending: true })
      .then(({ data }) => {
        if (!data) return;
        setExpiringDocs(
          data.map((d) => ({
            ...d,
            days_until: daysUntil(d.lease_expiration_date),
          }))
        );
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPreferences = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();
      if (userErr || !user) {
        setError("You must be signed in to manage deal alerts.");
        setLoading(false);
        return;
      }

      const { data, error: fetchErr } = await supabase
        .from("alerts")
        .select("id, min_score, county, acreage_min")
        .eq("user_id", user.id)
        .maybeSingle();

      if (fetchErr) {
        setError(formatReturnedError(fetchErr) || "Could not load alert preferences.");
        setLoading(false);
        return;
      }

      if (data) {
        const row = data as {
          id: string;
          min_score: number | null;
          county: string | null;
          acreage_min: string | number | null;
        };
        setAlertRowId(row.id ?? null);
        const score =
          row.min_score != null &&
          MIN_SCORE_OPTIONS.includes(row.min_score as (typeof MIN_SCORE_OPTIONS)[number])
            ? row.min_score
            : 50;
        setMinScore(score);
        setCounty(typeof row.county === "string" ? row.county.trim() : "");
        if (row.acreage_min != null && row.acreage_min !== "") {
          const n = typeof row.acreage_min === "number" ? row.acreage_min : parseFloat(String(row.acreage_min));
          setAcreageMin(!Number.isNaN(n) && Number.isFinite(n) ? String(n) : "");
        } else {
          setAcreageMin("");
        }
      } else {
        setAlertRowId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load alert preferences.");
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();
      if (userErr || !user) {
        setError("You must be signed in to save deal alerts.");
        setSaving(false);
        return;
      }

      const trimmedCounty = county.trim();
      const acreageTrim = acreageMin.trim();
      let acreageMinValue: number | null = null;
      if (acreageTrim) {
        const n = parseFloat(acreageTrim);
        if (Number.isNaN(n) || !Number.isFinite(n) || n < 0) {
          setError("Acreage minimum must be a valid non-negative number.");
          setSaving(false);
          return;
        }
        acreageMinValue = n;
      }

      const countyValue = trimmedCounty.length > 0 ? trimmedCounty : null;

      if (alertRowId) {
        const { error: updateErr } = await supabase
          .from("alerts")
          .update({
            min_score: minScore,
            county: countyValue,
            acreage_min: acreageMinValue,
          })
          .eq("user_id", user.id);

        if (updateErr) {
          setError(formatReturnedError(updateErr) || "Could not save alert preferences.");
          setSaving(false);
          return;
        }
      } else {
        const createdAt = new Date().toISOString();
        const { data: inserted, error: insertErr } = await supabase
          .from("alerts")
          .insert({
            user_id: user.id,
            min_score: minScore,
            county: countyValue,
            acreage_min: acreageMinValue,
            created_at: createdAt,
          })
          .select("id")
          .maybeSingle();

        if (insertErr) {
          setError(formatReturnedError(insertErr) || "Could not save alert preferences.");
          setSaving(false);
          return;
        }
        if (inserted?.id) {
          setAlertRowId(inserted.id);
        }
      }

      setSuccess("Alert preferences saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save alert preferences.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Alerts</h1>
        <p>Lease expiration alerts — emails sent at 90, 30, and 7 days before expiration</p>
      </div>

      {/* Upcoming expirations */}
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Expiring within 90 days
        </h2>
        {expiringDocs.length === 0 ? (
          <p style={{ fontSize: "0.88rem", color: "#9ca3af", margin: 0 }}>
            No leases expiring in the next 90 days. Expiration dates are automatically calculated from each document&apos;s effective date and term length.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {expiringDocs.map((doc) => {
              const s = urgencyStyle(doc.days_until);
              const loc = [doc.county ? `${doc.county} County` : null, doc.state].filter(Boolean).join(", ");
              return (
                <div key={doc.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.7rem 1rem", background: s.background, border: `1px solid ${s.border}`, borderRadius: 8, gap: "1rem", flexWrap: "wrap" }}>
                  <div>
                    <p style={{ margin: 0, fontWeight: 600, fontSize: "0.88rem", color: "#111827" }}>
                      {doc.file_name ?? "Untitled document"}
                    </p>
                    {loc && <p style={{ margin: "0.1rem 0 0", fontSize: "0.78rem", color: "#6b7280" }}>{loc}</p>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: "0.95rem", color: s.color }}>
                        {doc.days_until}d
                      </p>
                      <p style={{ margin: 0, fontSize: "0.72rem", color: "#6b7280" }}>{formatDate(doc.lease_expiration_date)}</p>
                    </div>
                    <Link href={`/documents/${doc.id}`} style={{ fontSize: "0.78rem", color: "#2563eb", textDecoration: "none", fontWeight: 500, whiteSpace: "nowrap" }}>
                      View →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card" style={{ maxWidth: 480 }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Alert criteria
        </h2>
        {loading ? (
          <p style={{ color: "#666", fontSize: "0.9rem" }}>Loading…</p>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="alert-min-score" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                Minimum score
              </label>
              <select
                id="alert-min-score"
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                style={inputStyle}
              >
                {MIN_SCORE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="alert-county" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                County <span style={{ color: "#888" }}>(optional)</span>
              </label>
              <input
                id="alert-county"
                type="text"
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                placeholder="e.g. Reeves, Midland"
                style={inputStyle}
              />
            </div>
            <div>
              <label htmlFor="alert-acreage-min" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                Acreage minimum <span style={{ color: "#888" }}>(optional)</span>
              </label>
              <input
                id="alert-acreage-min"
                type="text"
                inputMode="decimal"
                value={acreageMin}
                onChange={(e) => setAcreageMin(e.target.value)}
                placeholder="e.g. 40"
                style={inputStyle}
              />
            </div>
            <div>
              <button type="submit" className="btn btnPrimary" disabled={saving}>
                {saving ? "Saving…" : "Save preferences"}
              </button>
            </div>
            {error && (
              <p role="alert" style={{ color: "#b91c1c", fontSize: "0.85rem", margin: 0 }}>
                {error}
              </p>
            )}
            {success && (
              <p role="status" style={{ color: "#15803d", fontSize: "0.85rem", margin: 0 }}>
                {success}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
