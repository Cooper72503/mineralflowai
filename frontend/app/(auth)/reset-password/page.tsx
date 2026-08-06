import type { Metadata } from "next";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set new password — MineralFlow AI",
};

export default function ResetPasswordPage() {
  return (
    <div className="auth-page">
      <ResetPasswordForm />
    </div>
  );
}
