import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchTrialStatus } from "@/lib/trial/trial-status";
import { OnboardingClient } from "./OnboardingClient";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const trialStatus = await fetchTrialStatus(supabase, user.id);

  // Already has an active trial or paid plan — send to dashboard
  if (trialStatus.state === "active" || trialStatus.state === "paid") {
    redirect("/underwriting");
  }

  return <OnboardingClient email={user.email ?? ""} />;
}
