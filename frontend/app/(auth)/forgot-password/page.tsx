import type { Metadata } from "next";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Reset password — MineralFlow AI",
};

export default function ForgotPasswordPage() {
  return (
    <div className="auth-page">
      <ForgotPasswordForm />
    </div>
  );
}
