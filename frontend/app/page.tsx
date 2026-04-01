import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LandingPage } from "./components/landing/LandingPage";
import { getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Mineral Flow AI — Evaluate mineral deals in minutes",
  description:
    "Upload deeds, leases, division orders, or revenue documents. Get a deal score, financial output when data is present, and clear reasoning — built for landmen and acquisition teams.",
};

export default async function HomePage() {
  const user = await getSessionUser();
  if (user) {
    redirect("/dashboard");
  }

  return <LandingPage />;
}
