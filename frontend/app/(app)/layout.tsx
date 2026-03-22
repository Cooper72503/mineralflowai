import { Sidebar } from "../components/Sidebar";

/** Client routes under (app) use Supabase in useMemo/SSR; avoid static prerender without request/env. */
export const dynamic = "force-dynamic";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">{children}</main>
    </div>
  );
}
