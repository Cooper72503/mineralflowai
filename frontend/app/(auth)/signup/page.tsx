import Link from "next/link";
import { SignupForm } from "./SignupForm";

export const dynamic = "force-dynamic";

export default function SignupPage() {
  return (
    <div className="auth-page">
      <SignupForm />
      <p className="auth-footer">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </div>
  );
}
