import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LandingPage } from "./components/landing/LandingPage";
import { getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Mineral Flow AI — Working Interest Underwriting Platform",
  description:
    "Enter an API number. Get 36 months of TRRC production, Arps decline curve analysis, multi-scenario NPV, offer range, and a six-dimension risk score — backed by live EIA pricing and basin benchmarks.",
};

export default async function HomePage() {
  const user = await getSessionUser();
  if (user) {
    redirect("/underwriting");
  }

  return <LandingPage />;
}
