import { redirect } from "next/navigation";

/** The package intake is now the Due Diligence Engine; keep old links working. */
export default async function PortfolioRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const pkg = (await searchParams).package;
  redirect(typeof pkg === "string" && /^[0-9a-f-]{36}$/i.test(pkg) ? `/trrc-due-diligence?package=${pkg}` : "/trrc-due-diligence");
}
