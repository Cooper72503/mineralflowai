import { Resend } from "resend";

let _resend: Resend | null = null;

export function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    _resend = new Resend(key);
  }
  return _resend;
}

export const RESEND_CONFIGURED = Boolean(process.env.RESEND_API_KEY);
export const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ?? "alerts@mineralflowai.com";

export type LeaseAlertEmailPayload = {
  to: string;
  owner: string | null;
  county: string | null;
  state: string | null;
  file_name: string | null;
  expiration_date: string; // YYYY-MM-DD
  days_until: number;
  document_url: string;
};

export async function sendLeaseAlertEmail(p: LeaseAlertEmailPayload) {
  const resend = getResend();

  const urgency =
    p.days_until <= 7
      ? "⚠️ URGENT"
      : p.days_until <= 30
      ? "🔔 Action needed"
      : "📅 Heads up";

  const location = [p.county ? `${p.county} County` : null, p.state]
    .filter(Boolean)
    .join(", ");

  const formattedDate = new Date(p.expiration_date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const subject = `${urgency}: Lease expiring in ${p.days_until} days${location ? ` — ${location}` : ""}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; margin: 0; padding: 0;">
  <div style="max-width: 560px; margin: 2rem auto; background: #fff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden;">

    <!-- Header -->
    <div style="background: ${p.days_until <= 7 ? "#dc2626" : p.days_until <= 30 ? "#d97706" : "#2563eb"}; padding: 1.5rem 2rem;">
      <p style="color: rgba(255,255,255,0.8); font-size: 0.8rem; margin: 0 0 0.25rem; text-transform: uppercase; letter-spacing: 0.08em;">Mineral Flow AI · Lease Alert</p>
      <h1 style="color: #fff; font-size: 1.35rem; font-weight: 700; margin: 0;">
        Lease expiring in <strong>${p.days_until} day${p.days_until === 1 ? "" : "s"}</strong>
      </h1>
    </div>

    <!-- Body -->
    <div style="padding: 1.75rem 2rem;">
      <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem; margin-bottom: 1.5rem;">
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 0.6rem 0; color: #6b7280; width: 40%;">Expiration date</td>
          <td style="padding: 0.6rem 0; font-weight: 600; color: #111827;">${formattedDate}</td>
        </tr>
        ${p.owner ? `
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 0.6rem 0; color: #6b7280;">Owner / Lessor</td>
          <td style="padding: 0.6rem 0; color: #111827;">${p.owner}</td>
        </tr>` : ""}
        ${location ? `
        <tr style="border-bottom: 1px solid #f3f4f6;">
          <td style="padding: 0.6rem 0; color: #6b7280;">Location</td>
          <td style="padding: 0.6rem 0; color: #111827;">${location}</td>
        </tr>` : ""}
        ${p.file_name ? `
        <tr>
          <td style="padding: 0.6rem 0; color: #6b7280;">Document</td>
          <td style="padding: 0.6rem 0; color: #111827;">${p.file_name}</td>
        </tr>` : ""}
      </table>

      <a href="${p.document_url}"
         style="display: inline-block; padding: 0.65rem 1.5rem; background: #2563eb; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem;">
        View Document →
      </a>

      <p style="margin-top: 1.5rem; font-size: 0.78rem; color: #9ca3af; line-height: 1.6;">
        You're receiving this because you have lease expiration alerts enabled in Mineral Flow AI.
        <a href="${p.document_url.split("/documents")[0]}/alerts" style="color: #6b7280;">Manage alert preferences</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  return resend.emails.send({
    from: FROM_EMAIL,
    to: p.to,
    subject,
    html,
  });
}
