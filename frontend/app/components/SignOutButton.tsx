"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.auth.signOut();
      if (error) { setIsSigningOut(false); return; }
      router.replace("/login");
      router.refresh();
    } catch {
      setIsSigningOut(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={isSigningOut}
      className="btn btnSecondary"
      style={{ width: "100%", justifyContent: "center" }}
    >
      {isSigningOut ? "Signing out…" : "Sign out"}
    </button>
  );
}
