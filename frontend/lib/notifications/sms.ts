import twilio from "twilio";

/**
 * MineralFlow AI's own Twilio account for permit-alert SMS. Deliberately
 * separate from any client-project Twilio account (e.g. Ambrose's) — a
 * toll-free number's verification is tied to the specific business/use
 * case it was submitted under, and this is a different, multi-tenant
 * product sending to MineralFlow AI's own customers, not one client's
 * employees.
 *
 * No-ops (logs and returns) until TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 * TWILIO_PHONE_NUMBER are set — safe to deploy ahead of having a live
 * Twilio account.
 */

function cleanEnv(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  // Same corrupted-copy-paste guard used elsewhere in this codebase
  // (see lib/supabase/env.ts) — a masked/truncated secret pasted by
  // mistake fails loudly here instead of silently failing every send.
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 127) {
      console.error(`[sms] ${name} contains a non-ASCII character — likely a corrupted paste. Refusing to use it.`);
      return null;
    }
  }
  return raw;
}

function getClient(): { client: ReturnType<typeof twilio>; fromNumber: string } | null {
  const accountSid = cleanEnv("TWILIO_ACCOUNT_SID");
  const authToken = cleanEnv("TWILIO_AUTH_TOKEN");
  const fromNumber = cleanEnv("TWILIO_PHONE_NUMBER");
  if (!accountSid || !authToken || !fromNumber) return null;
  return { client: twilio(accountSid, authToken), fromNumber };
}

export interface PermitAlertRecipient {
  userId: string;
  phoneNumber: string;
}

export interface PermitAlertDetails {
  operatorName: string | null;
  leaseName: string | null;
  county: string | null;
  wellNumber: string | null;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://mineralflowai.com";

function messageBody(details: PermitAlertDetails): string {
  const operator = details.operatorName ?? "Unknown operator";
  const lease = details.leaseName ? ` — ${details.leaseName}` : "";
  const well = details.wellNumber ? ` #${details.wellNumber}` : "";
  const county = details.county ? ` (${details.county} County)` : "";
  return (
    `MineralFlow AI: New drilling permit filed by ${operator}${lease}${well}${county}. ` +
    `View: ${APP_URL}/trrc-permit-tracker`
  );
}

/**
 * Sends one permit-alert SMS per recipient. Best-effort — a delivery
 * failure for one recipient never throws for the others; the caller is
 * responsible for only marking (permit, user) pairs as sent once this
 * resolves without throwing for that pair.
 */
export async function sendPermitAlertSms(
  recipients: PermitAlertRecipient[],
  details: PermitAlertDetails
): Promise<{ userId: string; ok: boolean; error?: string }[]> {
  const cfg = getClient();
  if (!cfg) {
    console.warn("[sms] Twilio not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER) — skipping send.");
    return recipients.map((r) => ({ userId: r.userId, ok: false, error: "twilio_not_configured" }));
  }

  const body = messageBody(details);

  return Promise.all(
    recipients.map(async (r) => {
      try {
        await cfg.client.messages.create({ to: r.phoneNumber, from: cfg.fromNumber, body });
        return { userId: r.userId, ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[sms] send failed for user ${r.userId}:`, message);
        return { userId: r.userId, ok: false, error: message };
      }
    })
  );
}
