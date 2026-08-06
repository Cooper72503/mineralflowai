import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader } from "../components/PublicHeader";
import { PublicFooter } from "../components/PublicFooter";

export const metadata: Metadata = {
  title: "Terms of Service — MineralFlow AI",
  description: "Terms of Service for MineralFlow AI.",
};

const EFFECTIVE_DATE = "April 18, 2025";
const CONTACT_EMAIL = "cbosher@mineralflowai.com";

export default function TermsPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#0a1628", color: "#e2e8f0" }}>
      <PublicHeader />

      <main style={{ maxWidth: 780, margin: "0 auto", padding: "3rem 1.5rem 5rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: 700, color: "#f8fafc", marginBottom: "0.5rem" }}>
          Terms of Service
        </h1>
        <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "2.5rem" }}>
          Effective date: {EFFECTIVE_DATE}
        </p>

        <LegalSection title="1. Acceptance of Terms">
          <p>
            By accessing or using MineralFlow AI (the "Service"), you agree to be bound by these Terms of
            Service ("Terms"). If you do not agree, do not use the Service. These Terms form a legally
            binding agreement between you and MineralFlow AI ("Company," "we," "us," or "our").
          </p>
        </LegalSection>

        <LegalSection title="2. Description of Service">
          <p>
            MineralFlow AI is an AI-powered software platform designed to assist mineral rights
            professionals — including landmen, acquisition teams, and mineral buyers — with acquisition
            due diligence on Texas oil and gas wells and leases. Given a well API number, lease number,
            operator name, or legal description, the Service retrieves public records from the Texas
            Railroad Commission (TRRC) and returns a structured due diligence report, including
            engineering, economic, and risk analysis derived from that public data.
          </p>
        </LegalSection>

        <LegalSection title="3. Eligibility">
          <p>
            You must be at least 18 years old and have the legal authority to enter into contracts to use
            the Service. By using the Service, you represent that you meet these requirements.
          </p>
        </LegalSection>

        <LegalSection title="4. Accounts and Security">
          <p>
            You are responsible for maintaining the confidentiality of your account credentials and for
            all activity that occurs under your account. Notify us immediately at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} style={linkStyle}>{CONTACT_EMAIL}</a> if you suspect
            unauthorized use. We are not liable for losses resulting from unauthorized access caused by
            your failure to safeguard your credentials.
          </p>
        </LegalSection>

        <LegalSection title="5. Subscriptions and Billing">
          <p>
            Paid plans are billed on a monthly or annual basis via Stripe. Pricing is displayed on our{" "}
            <Link href="/pricing" style={linkStyle}>Pricing</Link> page and may change with 30 days'
            notice.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Free trial.</strong> Certain plans include a 7-day free
            trial. No charge is applied until day 8. You may cancel at any time during the trial period
            at no cost. After the trial, your payment method on file will be charged for the applicable
            subscription plan.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Cancellation.</strong> You may cancel your subscription
            at any time through your billing settings or by contacting us. Cancellation takes effect at
            the end of the current billing period; no refunds are issued for partial periods unless
            required by applicable law.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Taxes.</strong> Prices are exclusive of applicable taxes.
            You are responsible for all taxes associated with your use of the Service.
          </p>
        </LegalSection>

        <LegalSection title="6. Acceptable Use">
          <p>You agree not to:</p>
          <ul style={listStyle}>
            <li>Use the Service for any unlawful purpose or in violation of any applicable law or regulation.</li>
            <li>Attempt to reverse-engineer, decompile, or extract the underlying models or source code.</li>
            <li>Resell or sublicense access to the Service without written permission.</li>
            <li>Use automated scripts or bots to scrape or abuse the platform.</li>
            <li>Submit search inputs for an unlawful purpose or to harass, defraud, or infringe the rights of any third party.</li>
          </ul>
        </LegalSection>

        <LegalSection title="7. AI Outputs — Important Disclaimer">
          <p>
            <strong style={{ color: "#F0CC6E" }}>
              Outputs produced by the Service are directional and informational only. They do not
              constitute legal advice, financial advice, investment advice, or appraisal opinions.
            </strong>
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            Valuation ranges, deal scores, financial estimates, and extracted field values are generated
            algorithmically from publicly available regulatory records. Accuracy depends on the
            completeness and timeliness of those public records, which may be delayed, amended, or
            incorrectly indexed by the source agency. You should independently verify all material
            figures before making acquisition decisions, executing transactions, or relying on any output
            for legal or financial purposes.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            Mineral rights transactions involve complex legal and financial considerations. We strongly
            recommend working with a licensed attorney, certified appraiser, or qualified financial
            advisor for any material deal.
          </p>
        </LegalSection>

        <LegalSection title="8. Intellectual Property">
          <p>
            The Service, including its software, models, interfaces, and branding, is owned by
            MineralFlow AI and protected by applicable intellectual property laws. Nothing in these Terms
            transfers any ownership rights to you.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            You retain all rights to the reports generated for your account. We grant you a limited,
            non-exclusive license to use those reports for your own internal business purposes.
          </p>
        </LegalSection>

        <LegalSection title="9. Data and Privacy">
          <p>
            Your use of the Service is subject to our{" "}
            <Link href="/privacy" style={linkStyle}>Privacy Policy</Link>, which is incorporated into
            these Terms by reference.
          </p>
        </LegalSection>

        <LegalSection title="10. Confidentiality">
          <p>
            We treat your search inputs and generated reports as confidential. We do not sell your
            reports or data to third parties. This data is processed to provide the Service and may be
            retained as described in our Privacy Policy. We implement reasonable technical and
            organizational measures to protect your data.
          </p>
        </LegalSection>

        <LegalSection title="11. Third-Party Services">
          <p>
            The Service integrates with third-party providers including Stripe (payment processing),
            Supabase (data storage), and Anthropic (AI analysis), and retrieves public records from the
            Texas Railroad Commission (TRRC). Your use of those services is also subject to their
            respective terms and privacy policies. We are not responsible for the practices of
            third-party providers.
          </p>
        </LegalSection>

        <LegalSection title="12. Disclaimers">
          <p>
            THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS
            OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
            PARTICULAR PURPOSE, OR NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
            UNINTERRUPTED, ERROR-FREE, OR THAT OUTPUTS WILL BE ACCURATE OR COMPLETE.
          </p>
        </LegalSection>

        <LegalSection title="13. Limitation of Liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL MINERAL FLOW AI, ITS
            OFFICERS, DIRECTORS, EMPLOYEES, OR AGENTS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
            CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED
            DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL, OR OTHER INTANGIBLE LOSSES,
            ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE SERVICE, EVEN IF ADVISED OF THE
            POSSIBILITY OF SUCH DAMAGES.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            OUR TOTAL LIABILITY FOR ANY CLAIMS ARISING FROM OR RELATING TO THESE TERMS OR THE SERVICE
            SHALL NOT EXCEED THE GREATER OF (A) THE TOTAL FEES PAID BY YOU TO US IN THE TWELVE (12)
            MONTHS PRECEDING THE CLAIM, OR (B) ONE HUNDRED U.S. DOLLARS ($100).
          </p>
        </LegalSection>

        <LegalSection title="14. Indemnification">
          <p>
            You agree to indemnify and hold harmless MineralFlow AI and its affiliates, officers,
            directors, and employees from any claims, losses, damages, liabilities, costs, and expenses
            (including reasonable attorneys' fees) arising out of or relating to your use of the Service,
            your violation of these Terms, or your violation of any third-party rights.
          </p>
        </LegalSection>

        <LegalSection title="15. Termination">
          <p>
            We may suspend or terminate your access to the Service at any time for violation of these
            Terms, non-payment, or any other reason at our discretion, with or without notice. You may
            terminate your account at any time by canceling your subscription and stopping use of the
            Service.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            Upon termination, your right to use the Service ceases immediately. Sections 7, 8, 12, 13,
            14, 16, and 17 survive termination.
          </p>
        </LegalSection>

        <LegalSection title="16. Governing Law and Dispute Resolution">
          <p>
            These Terms are governed by the laws of the State of Texas, without regard to its conflict
            of law provisions. Any dispute arising from these Terms or your use of the Service shall be
            resolved by binding arbitration administered by the American Arbitration Association under
            its Commercial Arbitration Rules, with proceedings conducted in Texas. Notwithstanding the
            foregoing, either party may seek injunctive or other equitable relief in a court of competent
            jurisdiction to protect intellectual property rights.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <strong style={{ color: "#f8fafc" }}>Class action waiver.</strong> You agree that any dispute
            resolution proceedings will be conducted on an individual basis and not in a class,
            consolidated, or representative action.
          </p>
        </LegalSection>

        <LegalSection title="17. Changes to These Terms">
          <p>
            We may update these Terms from time to time. We will notify you of material changes by
            posting the new Terms on this page and updating the effective date, or by email. Your
            continued use of the Service after changes take effect constitutes your acceptance of the
            revised Terms.
          </p>
        </LegalSection>

        <LegalSection title="18. Contact">
          <p>
            Questions about these Terms? Contact us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} style={linkStyle}>{CONTACT_EMAIL}</a>.
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
