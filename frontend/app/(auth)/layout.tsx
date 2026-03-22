/** Auth routes use client forms and Supabase on the client; skip static generation. */
export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
