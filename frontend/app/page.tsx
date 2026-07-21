import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LandingPage } from "./components/landing/LandingPage";
import { getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Mineral Flow AI — Working Interest Underwriting Platform",
  description:
    "Enter an API number or RRC lease ID. Get full TRRC production history, Arps decline curve analysis, seller claim verification, title risk assessment, multi-scenario NPV, and a gated offer range — backed by live EIA pricing and basin benchmarks.",
};

export default async function HomePage() {
  const user = await getSessionUser();
  if (user) {
    redirect("/trrc-due-diligence");
  }

  return <LandingPage />;
}
