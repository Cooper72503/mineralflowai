import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { fetchTrialStatus } from "@/lib/trial/trial-status";
import { Sidebar } from "../components/Sidebar";
import { TrialBanner } from "../components/TrialBanner";

export const dynamic = "force-dynamic";

// Routes accessible even when trial is expired
const ALWAYS_ALLOWED = ["/billing", "/trial-expired", "/settings"];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") ?? "/";

  const supabase = await createClient();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("auth timeout")), 4000)
  );
  let user = null;
  try {
    const { data } = await Promise.race([supabase.auth.getUser(), timeout]);
    user = data.user;
  } catch {
    redirect("/login");
  }

  // Middleware handles unauthenticated → /login, but guard here too
  if (!user) redirect("/login");

  const alwaysAllowed = ALWAYS_ALLOWED.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  const trialStatus = await fetchTrialStatus(supabase, user.id);

  if (!alwaysAllowed) {
    if (trialStatus.state === "no_trial") {
      redirect("/onboarding");
    }
    if (trialStatus.state === "expired") {
      redirect("/trial-expired");
    }
    // "error" = table not set up yet — fail open so setup isn't blocked
  }

  const daysLeft =
    trialStatus.state === "active" ? trialStatus.daysLeft : null;
  const isPaid = trialStatus.state === "paid";

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        {!isPaid && daysLeft !== null && <TrialBanner daysLeft={daysLeft} />}
        {children}
      </main>
    </div>
  );
}
