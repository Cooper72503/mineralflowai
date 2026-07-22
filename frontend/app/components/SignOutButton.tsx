"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    const supabase = createClient();
    try {
      await supabase.auth.signOut();
    } catch {
      // signOut clears local session even if the API call fails
    }
    window.location.href = "/login";
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
