"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    if (isSigningOut) return;
    console.log("LOGOUT START");
    setIsSigningOut(true);
    const supabase = createClient();
    try {
      const response = await supabase.auth.signOut();
      if (response.error) {
        console.log("LOGOUT ERROR", response.error);
        setIsSigningOut(false);
        return;
      }
      console.log("LOGOUT RESPONSE", response);
      router.replace("/login");
      router.refresh();
    } catch (err) {
      console.log("LOGOUT ERROR", err);
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
      Sign out
    </button>
  );
}
