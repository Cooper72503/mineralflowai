"use client";

import { useState } from "react";

export function SignOutButton() {
  const [isSigningOut, setIsSigningOut] = useState(false);

  function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    window.location.href = "/api/auth/signout";
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
