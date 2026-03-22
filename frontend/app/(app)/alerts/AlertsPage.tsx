"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

const MIN_SCORE_OPTIONS = [50, 60, 70, 80] as const;

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
        <h1>Deal Alerts</h1>
        <p>Get notified when processed documents match your criteria (logging only for now)</p>
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
