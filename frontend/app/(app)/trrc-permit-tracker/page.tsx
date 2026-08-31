"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ALL_COUNTY_NAMES } from "@/lib/trrc/permit-tracker/county-codes";
import type { PermitSearchRow } from "@/lib/trrc/permit-tracker/search-results";
import { createClient } from "@/lib/supabase/client";
import { fetchTrialStatus } from "@/lib/trial/trial-status";

// ─── Design tokens (matches TRRC Due Diligence / UnderwritingPage.tsx) ────────

const COLORS = {
  bg:           "#0f1117",
  surface:      "#181c25",
  border:       "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.15)",
  text:         "#e2e8f0",
  textMuted:    "#8892a4",
  textFaint:    "#5a6478",
  accent:       "#4f8ef7",
  accentDim:    "rgba(79,142,247,0.12)",
  green:        "#22c55e",
  greenDim:     "rgba(34,197,94,0.12)",
  yellow:       "#f59e0b",
  yellowDim:    "rgba(245,158,11,0.12)",
  red:          "#ef4444",
};

const QUICK_COUNTIES = [
  "MIDLAND", "ECTOR", "REEVES", "LOVING", "WARD", "CULBERSON",
  "HOWARD", "MARTIN", "ANDREWS", "GLASSCOCK", "UPTON", "REAGAN",
  "KARNES", "DEWITT", "GONZALES",
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function statusColor(status: string | null): { bg: string; color: string } {
  const s = (status ?? "").toLowerCase();
  if (s.includes("approved")) return { bg: COLORS.greenDim, color: COLORS.green };
  if (s.includes("denied") || s.includes("void")) return { bg: "rgba(239,68,68,0.12)", color: COLORS.red };
  return { bg: COLORS.yellowDim, color: COLORS.yellow };
}

const inputStyle: CSSProperties = {
  background: COLORS.bg,
  border: `1px solid ${COLORS.borderStrong}`,
  borderRadius: 6,
  padding: "0.4rem 0.6rem",
  color: COLORS.text,
  fontSize: "0.8rem",
};

function CountyPicker({
  selected,
  onChange,
  datalistId,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  datalistId: string;
}) {
  const [input, setInput] = useState("");

  function toggle(name: string) {
    onChange(selected.includes(name) ? selected.filter((c) => c !== name) : [...selected, name]);
  }
  function addFromInput() {
    const name = input.trim().toUpperCase();
    if (name && ALL_COUNTY_NAMES.includes(name) && !selected.includes(name)) {
      onChange([...selected, name]);
    }
    setInput("");
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.6rem" }}>
        {QUICK_COUNTIES.map((c) => {
          const active = selected.includes(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggle(c)}
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                padding: "0.35rem 0.7rem",
                borderRadius: 6,
                border: `1px solid ${active ? COLORS.accent : COLORS.borderStrong}`,
                background: active ? COLORS.accentDim : "transparent",
                color: active ? COLORS.accent : COLORS.textMuted,
                cursor: "pointer",
              }}
            >
              {c.charAt(0) + c.slice(1).toLowerCase()}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <input
          list={datalistId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFromInput(); } }}
          placeholder="Add another county…"
          style={{ ...inputStyle, width: 220 }}
        />
        <datalist id={datalistId}>
          {ALL_COUNTY_NAMES.map((c) => <option key={c} value={c} />)}
        </datalist>
        <button
          type="button"
          onClick={addFromInput}
          style={{
            fontSize: "0.75rem", fontWeight: 600, padding: "0.4rem 0.7rem",
            borderRadius: 6, border: `1px solid ${COLORS.borderStrong}`,
            background: "transparent", color: COLORS.textMuted, cursor: "pointer",
          }}
        >
          Add
        </button>
        {selected.length > 0 && (
          <span style={{ fontSize: "0.75rem", color: COLORS.textFaint }}>
            {selected.length} selected
          </span>
        )}
      </div>
    </div>
  );
}

interface AlertSubscription {
  phone_number: string | null;
  sms_enabled: boolean;
  counties: string[];
}

function AlertPanel() {
  const supabase = createClient();
  const [status, setStatus] = useState<"loading" | "not_paid" | "ready">("loading");
  const [phone, setPhone] = useState("");
  const [counties, setCounties] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const trial = await fetchTrialStatus(supabase, user.id);
      if (trial.state !== "paid") {
        setStatus("not_paid");
        return;
      }

      const { data } = await supabase
        .from("permit_alert_subscriptions")
        .select("phone_number, sms_enabled, counties")
        .eq("user_id", user.id)
        .maybeSingle();

      const sub = data as AlertSubscription | null;
      if (sub) {
        setPhone(sub.phone_number ?? "");
        setCounties(sub.counties ?? []);
        setEnabled(sub.sms_enabled);
      }
      setStatus("ready");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(nextEnabled: boolean) {
    setSaving(true);
    setMessage(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in.");
      if (nextEnabled && (!phone.trim() || counties.length === 0)) {
        setMessage({ ok: false, text: "Add a phone number and at least one county first." });
        return;
      }
      const { error } = await supabase
        .from("permit_alert_subscriptions")
        .upsert(
          { user_id: user.id, phone_number: phone.trim() || null, counties, sms_enabled: nextEnabled },
          { onConflict: "user_id" }
        );
      if (error) throw error;
      setEnabled(nextEnabled);
      setMessage({ ok: true, text: nextEnabled ? "SMS alerts on." : "SMS alerts off." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  if (status === "loading") return null;

  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      padding: "1.25rem 1.5rem",
      marginBottom: "1.5rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: status === "not_paid" ? 0 : "1rem" }}>
        <div style={{ fontSize: "0.75rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          SMS Alerts
        </div>
        {status === "ready" && (
          <span style={{
            fontSize: "0.68rem", fontWeight: 700, padding: "0.15rem 0.5rem", borderRadius: 4,
            background: enabled ? COLORS.greenDim : "rgba(255,255,255,0.06)",
            color: enabled ? COLORS.green : COLORS.textFaint,
          }}>
            {enabled ? "ON" : "OFF"}
          </span>
        )}
      </div>

      {status === "not_paid" ? (
        <p style={{ margin: 0, fontSize: "0.8rem", color: COLORS.textMuted }}>
          SMS alerts are part of the full platform engagement.{" "}
          <a href="mailto:cbosher@mineralflowai.com?subject=Enable%20SMS%20alerts" style={{ color: COLORS.accent }}>Contact your account team →</a>
        </p>
      ) : (
        <>
          <p style={{ margin: "0 0 1rem 0", fontSize: "0.8rem", color: COLORS.textMuted }}>
            Get a text the moment a new-drill permit is filed in a county you're watching. Checked once daily.
          </p>
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginBottom: "0.4rem" }}>Phone number</div>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+15551234567"
              style={{ ...inputStyle, width: 220 }}
            />
          </div>
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginBottom: "0.4rem" }}>Watched counties</div>
            <CountyPicker selected={counties} onChange={setCounties} datalistId="alert-county-options" />
          </div>
          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => save(!enabled)}
              disabled={saving}
              style={{
                fontSize: "0.8rem", fontWeight: 700, padding: "0.5rem 1.1rem",
                borderRadius: 6, border: "none",
                background: saving ? COLORS.textFaint : enabled ? "rgba(239,68,68,0.15)" : COLORS.accent,
                color: enabled ? COLORS.red : "#0f1117",
                cursor: saving ? "default" : "pointer",
              }}
            >
              {saving ? "Saving…" : enabled ? "Turn off alerts" : "Turn on alerts"}
            </button>
            {enabled && (
              <button
                type="button"
                onClick={() => save(true)}
                disabled={saving}
                style={{
                  fontSize: "0.8rem", fontWeight: 600, padding: "0.5rem 1.1rem",
                  borderRadius: 6, border: `1px solid ${COLORS.borderStrong}`,
                  background: "transparent", color: COLORS.textMuted, cursor: saving ? "default" : "pointer",
                }}
              >
                Save changes
              </button>
            )}
            {message && (
              <span style={{ fontSize: "0.75rem", color: message.ok ? COLORS.green : COLORS.red }}>
                {message.text}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function PermitTrackerPage() {
  const [selectedCounties, setSelectedCounties] = useState<string[]>(["MIDLAND"]);
  const [since, setSince] = useState(daysAgoIso(14));
  const [until, setUntil] = useState(todayIso());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PermitSearchRow[] | null>(null);
  const [skippedCounties, setSkippedCounties] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);

  async function runSearch() {
    if (selectedCounties.length === 0) {
      setError("Select at least one county.");
      return;
    }
    setLoading(true);
    setError(null);
    setRows(null);
    try {
      const res = await fetch("/api/trrc/permit-tracker/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ counties: selectedCounties, since, until }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Search failed.");
        return;
      }
      setRows(json.data.rows);
      setSkippedCounties(json.data.skippedCounties ?? []);
      setTruncated(json.data.truncated ?? false);
    } catch {
      setError("Search failed — network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "2.5rem 2rem",
    }}>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: "1.75rem" }}>
          <h1 style={{ margin: "0 0 0.4rem 0", fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
            TRRC Permit Tracker
          </h1>
          <p style={{ margin: 0, fontSize: "0.85rem", color: COLORS.textMuted }}>
            Live search of new-drill W-1 filings from the Texas Railroad Commission's public permit
            system, by county and date range.
          </p>
        </div>

        {/* SMS alerts */}
        <AlertPanel />

        {/* Search form */}
        <div style={{
          background: COLORS.surface,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: "1.25rem 1.5rem",
          marginBottom: "1.5rem",
        }}>
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.75rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>
              Counties
            </div>
            <CountyPicker selected={selectedCounties} onChange={setSelectedCounties} datalistId="search-county-options" />
          </div>

          <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "0.75rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.4rem" }}>
                Submitted since
              </div>
              <input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                max={until}
                style={{
                  background: COLORS.bg, border: `1px solid ${COLORS.borderStrong}`,
                  borderRadius: 6, padding: "0.4rem 0.6rem", color: COLORS.text, fontSize: "0.8rem",
                }}
              />
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.4rem" }}>
                Through
              </div>
              <input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                min={since}
                max={todayIso()}
                style={{
                  background: COLORS.bg, border: `1px solid ${COLORS.borderStrong}`,
                  borderRadius: 6, padding: "0.4rem 0.6rem", color: COLORS.text, fontSize: "0.8rem",
                }}
              />
            </div>
            <button
              type="button"
              onClick={runSearch}
              disabled={loading}
              style={{
                fontSize: "0.85rem", fontWeight: 700, padding: "0.55rem 1.25rem",
                borderRadius: 6, border: "none",
                background: loading ? COLORS.textFaint : COLORS.accent,
                color: "#0f1117", cursor: loading ? "default" : "pointer",
              }}
            >
              {loading ? "Searching…" : "Search"}
            </button>
          </div>

          <p style={{ margin: "0.75rem 0 0 0", fontSize: "0.72rem", color: COLORS.textFaint }}>
            Shows New Drill (Form W-1) filings only — the one filing-purpose code confirmed against
            live TRRC results. Recompletions, re-entries, and other filing types are not yet covered.
          </p>
        </div>

        {/* Errors / notices */}
        {error && (
          <div style={{
            background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.85rem", color: COLORS.red,
          }}>
            {error}
          </div>
        )}
        {skippedCounties.length > 0 && (
          <div style={{ fontSize: "0.75rem", color: COLORS.textFaint, marginBottom: "0.75rem" }}>
            Unrecognized county name{skippedCounties.length > 1 ? "s" : ""} skipped: {skippedCounties.join(", ")}
          </div>
        )}
        {truncated && (
          <div style={{ fontSize: "0.75rem", color: COLORS.yellow, marginBottom: "0.75rem" }}>
            Results were capped at 300 rows — narrow the date range or county list to see everything.
          </div>
        )}

        {/* Results */}
        {rows !== null && (
          <div style={{
            background: COLORS.surface, border: `1px solid ${COLORS.border}`,
            borderRadius: 10, padding: "1.25rem 1.5rem",
          }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "1rem" }}>
              {rows.length} permit{rows.length === 1 ? "" : "s"} found
            </div>
            {rows.length === 0 ? (
              <p style={{ color: COLORS.textFaint, fontSize: "0.85rem", margin: 0 }}>
                No new-drill filings for the selected counties and date range.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                  <thead>
                    <tr>
                      {["Operator", "Lease", "Well #", "County", "Dist.", "Profile", "Submitted", "Status"].map((h) => (
                        <th key={h} style={{
                          textAlign: "left", padding: "0.4rem 0.75rem", color: COLORS.textMuted,
                          fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.06em",
                          borderBottom: `1px solid ${COLORS.border}`, whiteSpace: "nowrap",
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const sc = statusColor(r.currentStatus);
                      return (
                        <tr key={`${r.apiNumber}-${i}`} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{r.operatorName ?? "—"}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{r.leaseName ?? "—"}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{r.wellNumber ?? "—"}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{r.county ?? "—"}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{r.district ?? "—"}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{r.wellboreProfile ?? "—"}</td>
                          <td style={{ padding: "0.5rem 0.75rem", whiteSpace: "nowrap" }}>{r.applicationDate ?? "—"}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>
                            <span style={{
                              display: "inline-block", fontSize: "0.68rem", fontWeight: 700,
                              padding: "0.15rem 0.5rem", borderRadius: 4, background: sc.bg, color: sc.color,
                              whiteSpace: "nowrap",
                            }}>
                              {r.currentStatus ?? "Unknown"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
