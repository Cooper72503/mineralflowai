import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader } from "../components/PublicHeader";
import { PublicFooter } from "../components/PublicFooter";

export const metadata: Metadata = {
  title: "Privacy Policy — MineralFlow AI",
  description: "Privacy Policy for MineralFlow AI.",
};

const EFFECTIVE_DATE = "April 18, 2025";
const CONTACT_EMAIL = "cbosher@mineralflowai.com";

export default function PrivacyPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#0a1628", color: "#e2e8f0" }}>
      <PublicHeader />

      <main style={{ maxWidth: 780, margin: "0 auto", padding: "3rem 1.5rem 5rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: 700, color: "#f8fafc", marginBottom: "0.5rem" }}>
          Privacy Policy
        </h1>
        <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "2.5rem" }}>
          Effective date: {EFFECTIVE_DATE}
        </p>

        <LegalSection title="1. Overview">
          <p>
            MineralFlow AI ("Company," "we," "us," or "our") is committed to protecting your privacy.
            This Privacy Policy explains what information we collect, how we use it, and your rights
            regarding that information when you use our platform at mineralflowai.com (the "Service").
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            By using the Service, you agree to the collection and use of information in accordance with
            this policy. If you do not agree, please do not use the Service.
          </p>
        </LegalSection>

        <LegalSection title="2. Information We Collect">
          <p>
            <strong style={{ color: "#f8fafc" }}>Account information.</strong> When you create an
            account, we collect your email address and a hashed password. We do not store plain-text
            passwords.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Search inputs and reports.</strong> When you submit a
            well API number, lease number, operator name, or legal description to run a due diligence
            report, we store that input along with the public regulatory records we retrieve and the
            report we generate from them.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Usage data.</strong> We collect standard server logs
            including IP address, browser type, pages visited, and timestamps. This helps us operate
            and improve the Service.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Billing information.</strong> Payment processing is
            handled entirely by Stripe. We do not store credit card numbers or full payment credentials.
            We receive and store a Stripe customer ID and subscription status.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Communications.</strong> If you contact us by email,
            we retain those communications to respond to you and improve the Service.
          </p>
        </LegalSection>

        <LegalSection title="3. How We Use Your Information">
          <ul style={listStyle}>
            <li>To provide, operate, and maintain the Service.</li>
            <li>To retrieve public regulatory records and generate AI-powered due diligence reports.</li>
            <li>To manage your subscription and process payments via Stripe.</li>
            <li>To send transactional emails such as account confirmations and billing receipts.</li>
            <li>To respond to your support requests and communications.</li>
            <li>To detect and prevent fraud, abuse, and security incidents.</li>
            <li>To improve our AI models and platform using aggregated, de-identified data. We do not use your identifiable reports or search inputs to train models shared with or sold to third parties.</li>
            <li>To comply with legal obligations.</li>
          </ul>
        </LegalSection>

        <LegalSection title="4. AI Processing and Confidentiality">
          <p>
            Your search inputs and the public regulatory records we retrieve on your behalf are processed
            to generate your due diligence report. We treat your reports and search history as
            confidential. We do not sell, rent, or share them with third parties except as necessary to
            operate the Service (e.g., passing search inputs and retrieved records to Anthropic's API for
            AI processing) or as required by law.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Anthropic processing.</strong> Your search inputs and the
            public regulatory records retrieved for your report are sent to Anthropic's Claude API to
            generate the report's analysis and narrative content. Anthropic's use of this data is governed
            by{" "}
            <a
              href="https://www.anthropic.com/legal/commercial-terms"
              target="_blank"
              rel="noopener noreferrer"
              style={linkStyle}
            >
              Anthropic's commercial terms
            </a>. We use the API under agreements that restrict Anthropic from using your data to train
            its models.
          </p>
        </LegalSection>

        <LegalSection title="5. Third-Party Service Providers">
          <p>We share limited data with the following categories of service providers to operate the Service:</p>
          <ul style={listStyle}>
            <li><strong style={{ color: "#f8fafc" }}>Stripe</strong> — payment processing. Receives your email and billing details to manage subscriptions.</li>
            <li><strong style={{ color: "#f8fafc" }}>Supabase</strong> — cloud database and authentication. Stores account information, search history, and generated reports in secure, encrypted databases.</li>
            <li><strong style={{ color: "#f8fafc" }}>Anthropic</strong> — AI report generation. Receives search inputs and public regulatory records for analysis. See Section 4.</li>
            <li><strong style={{ color: "#f8fafc" }}>Vercel</strong> — hosting and CDN. Hosts the web application and processes server-side requests.</li>
            <li><strong style={{ color: "#f8fafc" }}>Texas Railroad Commission (TRRC)</strong> — the source of the public regulatory records our reports are built from. We query TRRC's public well, lease, and operator databases using the identifiers you submit; no account or personal information is sent to TRRC.</li>
          </ul>
          <p style={{ marginTop: "0.75rem" }}>
            We do not sell your personal information to advertisers or data brokers.
          </p>
        </LegalSection>

        <LegalSection title="6. Cookies and Tracking">
          <p>
            We use cookies and similar technologies to maintain your authenticated session and store
            preferences. We do not use third-party advertising cookies or cross-site tracking cookies.
            Session cookies are necessary for the Service to function; you can disable them in your
            browser settings, but doing so will prevent you from using the Service.
          </p>
        </LegalSection>

        <LegalSection title="7. Data Retention">
          <p>
            We retain your account information, search history, and generated reports for as long as
            your account is active. If you delete your account, we will delete your personal data and
            reports within 30 days, except where retention is required by applicable law or to resolve
            disputes. Aggregated, de-identified usage statistics may be retained indefinitely.
          </p>
        </LegalSection>

        <LegalSection title="8. Data Security">
          <p>
            We implement industry-standard technical and organizational measures to protect your data,
            including encrypted data storage, HTTPS for all data transmission, access controls, and
            regular security reviews. No system is completely secure; we cannot guarantee absolute
            security, but we take reasonable precautions to protect your information.
          </p>
        </LegalSection>

        <LegalSection title="9. Your Rights">
          <p>Depending on your location, you may have the following rights regarding your personal data:</p>
          <ul style={listStyle}>
            <li><strong style={{ color: "#f8fafc" }}>Access.</strong> Request a copy of the personal data we hold about you.</li>
            <li><strong style={{ color: "#f8fafc" }}>Correction.</strong> Request correction of inaccurate personal data.</li>
            <li><strong style={{ color: "#f8fafc" }}>Deletion.</strong> Request deletion of your personal data, subject to legal retention requirements.</li>
            <li><strong style={{ color: "#f8fafc" }}>Portability.</strong> Request an export of your data in a machine-readable format.</li>
            <li><strong style={{ color: "#f8fafc" }}>Objection.</strong> Object to certain processing of your personal data.</li>
          </ul>
          <p style={{ marginTop: "0.75rem" }}>
            To exercise any of these rights, contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} style={linkStyle}>{CONTACT_EMAIL}</a>. We will respond
            within 30 days.
          </p>
        </LegalSection>

        <LegalSection title="10. California Residents (CCPA)">
          <p>
            If you are a California resident, you have the right to know what personal information we
            collect and how it is used, the right to delete personal information, and the right to
            opt out of the sale of personal information. We do not sell personal information. To
            exercise your rights, contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} style={linkStyle}>{CONTACT_EMAIL}</a>.
          </p>
        </LegalSection>

        <LegalSection title="11. Children's Privacy">
          <p>
            The Service is not directed to children under 18. We do not knowingly collect personal
            information from children under 18. If you believe we have inadvertently collected such
            information, contact us and we will delete it promptly.
          </p>
        </LegalSection>

        <LegalSection title="12. Changes to This Policy">
          <p>
            We may update this Privacy Policy from time to time. We will notify you of material changes
            by posting the revised policy on this page and updating the effective date, or by email.
            Continued use of the Service after changes take effect constitutes acceptance of the updated
            policy.
          </p>
        </LegalSection>

        <LegalSection title="13. Contact Us">
          <p>
            Questions or concerns about this Privacy Policy? Contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} style={linkStyle}>{CONTACT_EMAIL}</a>.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            For questions about your subscription or billing, you can also visit your{" "}
            <Link href="/billing" style={linkStyle}>billing settings</Link> or contact Stripe
            directly.
          </p>
        </LegalSection>
      </main>

      <PublicFooter variant="landing" />
    </div>
  );
}

function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#f8fafc", marginBottom: "0.75rem" }}>
        {title}
      </h2>
      <div style={{ color: "#cbd5e1", fontSize: "0.9rem", lineHeight: 1.75 }}>
        {children}
      </div>
    </section>
  );
}

const linkStyle: React.CSSProperties = { color: "#C9A84C", textDecoration: "none" };
const listStyle: React.CSSProperties = {
  paddingLeft: "1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  marginTop: "0.5rem",
};
