/**
 * Trial status helpers.
 *
 * Free trial = 7 days from trial_started_at.
 * subscription_status values:
 *   'none'      — account created, trial not yet activated
 *   'trialing'  — free trial active
 *   'active'    — paid subscription active
 *   'expired'   — trial ended, no paid plan
 *   'cancelled' — subscription cancelled
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const TRIAL_DAYS = 7;

export type TrialStatus =
  | { state: "no_trial" }
  | { state: "active"; daysLeft: number; endsAt: Date }
  | { state: "expired"; endedAt: Date }
  | { state: "paid" }
  | { state: "error" };

export interface UserProfile {
  trial_started_at: string | null;
  subscription_status: string | null;
}

export function computeTrialStatus(profile: UserProfile | null): TrialStatus {
  if (!profile) return { state: "no_trial" };

  const { trial_started_at, subscription_status } = profile;

  // Paid subscription — always allow
  if (subscription_status === "active") return { state: "paid" };

  // No trial started
  if (!trial_started_at) return { state: "no_trial" };

  const startedAt = new Date(trial_started_at);
  const endsAt = new Date(startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();

  if (now < endsAt) {
    const msLeft = endsAt.getTime() - now.getTime();
    const daysLeft = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
    return { state: "active", daysLeft, endsAt };
  }

  return { state: "expired", endedAt: endsAt };
}

/** Fetch trial status for the logged-in user from the profiles table. */
export async function fetchTrialStatus(
  supabase: SupabaseClient,
  userId: string,
): Promise<TrialStatus> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("trial_started_at, subscription_status")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      // Table might not exist yet during initial setup — fail open
      console.warn("[trial] profiles lookup failed:", error.message);
      return { state: "error" };
    }

    return computeTrialStatus(data as UserProfile | null);
  } catch (err) {
    console.warn("[trial] fetchTrialStatus threw:", err);
    return { state: "error" };
  }
}
