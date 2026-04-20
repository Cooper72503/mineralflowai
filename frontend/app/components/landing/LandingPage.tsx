import Link from "next/link";
import { Inter } from "next/font/google";
import { PublicHeader } from "../PublicHeader";
import { PublicFooter } from "../PublicFooter";
import styles from "./landing.module.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-landing",
});

const MAIL_DEMO =
  "mailto:cbosher@mineralflowai.com?subject=Book%20a%20demo%20%E2%80%94%20Mineral%20Flow%20AI";
const MAIL_CONTACT =
  "mailto:cbosher@mineralflowai.com?subject=Mineral%20Flow%20AI%20%E2%80%94%20Contact";

export function LandingPage() {
  return (
    <div className={`${inter.className} ${styles.page}`}>
      <PublicHeader variant="landing" />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className={styles.hero} aria-labelledby="hero-heading">
        <div className={styles.wrap}>
          <div className={styles.heroGrid}>
            <div>
              <span className={styles.eyebrow}>Mineral intelligence platform</span>
              <h1 id="hero-heading">
                Evaluate Mineral Deals in Minutes, Not Hours
              </h1>
              <p className={styles.subhead}>
                Upload deeds, leases, division orders, or revenue documents. Get
                a deal score, financial output, lease expiration alerts, and
                well activity — built for landmen and acquisition teams.
              </p>
              <p className={styles.trustLine}>
                91%+ accuracy on real mineral deals &nbsp;·&nbsp; Texas &amp; North Dakota well data &nbsp;·&nbsp; Automated lease alerts
              </p>
              <div className={styles.ctaRow}>
                <a className={styles.btnPrimary} href={MAIL_DEMO}>
                  Book a Demo
                </a>
                <Link className={styles.btnSecondary} href="/signup">
                  Get Started
                </Link>
              </div>
              <div className={styles.chips} aria-hidden>
                <span className={styles.chip}>Deal score</span>
                <span className={styles.chip}>Financial output</span>
                <span className={styles.chip}>Well data</span>
                <span className={styles.chip}>Lease alerts</span>
                <span className={styles.chip}>Deal pipeline</span>
              </div>
            </div>
            <div className={styles.heroMock} aria-hidden>
              <div className={styles.mockChrome}>
                <span className={styles.mockDot} />
                <span className={styles.mockDot} />
                <span className={styles.mockDot} />
              </div>
              <div className={styles.mockBody}>
                <div className={styles.mockLabel}>Deal score</div>
                <div className={styles.mockScore}>78</div>
                <div className={styles.mockBar}>
                  <div className={styles.mockBarFill} />
                </div>
                <div className={styles.mockRows}>
                  <div className={styles.mockRow} />
                  <div className={styles.mockRow} />
                  <div className={styles.mockRow} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Problem ──────────────────────────────────────────────────── */}
      <section
        id="problem"
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="problem-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="problem-heading">
            Manual deal evaluation slows everything down
          </h2>
          <p className={styles.sectionLead}>
            Mineral acquisition teams spend hours reviewing documents just to
            decide whether a deal is worth pursuing. That creates bottlenecks,
            burns labor, and causes strong opportunities to get missed.
          </p>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <div className={styles.statValue}>5–10 hrs</div>
              <div className={styles.statLabel}>
                Typical time spent per deal evaluation
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>$1K–$2K</div>
              <div className={styles.statLabel}>
                Labor cost per deal (directional range)
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>50–100+</div>
              <div className={styles.statLabel}>
                Deals per year — cost and delay add up fast
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Solution ─────────────────────────────────────────────────── */}
      <section className={styles.section} aria-labelledby="solution-heading">
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="solution-heading">
            Mineral Flow AI turns documents into decisions
          </h2>
          <p className={styles.sectionLead}>
            A full deal intelligence platform — from document intake to offer
            generation, well activity, and automated lease expiration alerts.
          </p>
          <div className={styles.featureGrid}>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconDoc />
              </div>
              <div>
                <h3>Ownership &amp; terms extraction</h3>
                <p>
                  Pulls ownership, acreage, legal description, royalty rate,
                  effective date, and key lease or deed terms from uploaded files.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconStar />
              </div>
              <div>
                <h3>Deal score &amp; reasoning</h3>
                <p>
                  Scores the deal with pursue vs. skip reasoning tied directly
                  to what was found in the document — not a black box.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconWell />
              </div>
              <div>
                <h3>Well data — TX &amp; ND</h3>
                <p>
                  Looks up active wells by county using Texas RRC and North
                  Dakota NDIC data. See API numbers, operators, and production
                  alongside your deal.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconBell />
              </div>
              <div>
                <h3>Lease expiration alerts</h3>
                <p>
                  Calculates expiration dates from extracted terms. Sends
                  automated email alerts at 90, 30, and 7 days before expiration.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconCurrency />
              </div>
              <div>
                <h3>Financial output</h3>
                <p>
                  When revenue or production data is present, surfaces monthly
                  and annual estimates, a valuation range, and confidence level.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconPipeline />
              </div>
              <div>
                <h3>Deal pipeline &amp; offers</h3>
                <p>
                  Track deals through stages, generate offers from extracted
                  financials, and manage your acquisition funnel in one place.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section
        id="how-it-works"
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="how-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="how-heading">
            How it works
          </h2>
          <p className={styles.sectionLead}>
            From document upload to a full deal view in minutes.
          </p>
          <div className={styles.steps}>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>1</div>
              <h3>Upload</h3>
              <p>Deed, lease, division order, or revenue statement — PDF or image.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>2</div>
              <h3>Extract</h3>
              <p>AI pulls ownership, terms, financials, and key fields with confidence scoring.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>3</div>
              <h3>Enrich</h3>
              <p>Well data added by county, expiration date calculated, deal scored automatically.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>4</div>
              <h3>Decide</h3>
              <p>Pursue, pass, or generate an offer — with all evidence in one place.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Product showcase ─────────────────────────────────────────── */}
      <section
        id="product"
        className={styles.section}
        aria-labelledby="product-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="product-heading">
            Inside the platform
          </h2>
          <p className={styles.sectionLead}>
            Every view built for speed and clarity in real acquisition workflows.
          </p>
          <div className={`${styles.showcaseGrid} ${styles.showcaseGridWide}`}>
            <ProductFrame
              title="Document upload"
              caption="Drag-and-drop upload with instant processing."
            />
            <ProductFrame
              title="AI extraction & confidence"
              caption="Structured fields with confidence on every value."
            />
            <ProductFrame
              title="Deal score &amp; reasoning"
              caption="Score with pursue vs. skip reasoning in one view."
            />
            <ProductFrame
              title="Well data by county"
              caption="TX RRC and ND NDIC well activity alongside your deal."
            />
            <ProductFrame
              title="Lease expiration alerts"
              caption="Upcoming expirations with 90 / 30 / 7-day email alerts."
            />
            <ProductFrame
              title="Deal pipeline"
              caption="Track deals from intake through offer and close."
            />
          </div>
        </div>
      </section>

      {/* ── Financial output ─────────────────────────────────────────── */}
      <section
        id="financial"
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="financial-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="financial-heading">
            If the document includes revenue, we show the economics
          </h2>
          <p className={styles.sectionLead}>
            When statements include usable revenue or production information,
            the platform surfaces monthly and annual figures, a rough valuation
            range, and confidence — with methodology alongside the numbers.
          </p>
          <div className={styles.finGrid}>
            <div>
              <p className={styles.sectionLead} style={{ marginBottom: "1rem" }}>
                Not every document contains financial data. If a file only shows
                ownership or legal language, the platform stays conservative
                and does not invent figures.
              </p>
              <div className={styles.noteBox}>
                Outputs are tied to what appears in the document. Teams should
                treat ranges as directional and validate material numbers in
                their own process.
              </div>
            </div>
            <div className={styles.finMock}>
              <h4>Example output</h4>
              <div className={styles.finRow}>
                <span>Monthly revenue (est.)</span>
                <strong>$12,400</strong>
              </div>
              <div className={styles.finRow}>
                <span>Annual revenue (est.)</span>
                <strong className={styles.finHighlight}>$148,800</strong>
              </div>
              <div className={styles.finRow}>
                <span>Valuation range (rough)</span>
                <strong>$1.1M – $1.4M</strong>
              </div>
              <div className={styles.finRow}>
                <span>Lease expires</span>
                <strong>Mar 2026 · 90-day alert sent</strong>
              </div>
              <div className={styles.finRow}>
                <span>Confidence</span>
                <strong>Medium</strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Alerts section ───────────────────────────────────────────── */}
      <section className={styles.section} aria-labelledby="alerts-heading">
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="alerts-heading">
            Never miss a lease expiration
          </h2>
          <p className={styles.sectionLead}>
            Mineral Flow AI calculates expiration dates from extracted effective
            dates and term lengths — then sends automated email alerts so your
            team always has time to act.
          </p>
          <div className={styles.confGrid}>
            <div className={styles.confCard}>
              <h3>Automated calculation</h3>
              <ul>
                <li>Parses effective date and term length from the uploaded document.</li>
                <li>Calculates expiration date on every processed lease — no manual tracking.</li>
              </ul>
            </div>
            <div className={styles.confCard}>
              <h3>Tiered email alerts</h3>
              <ul>
                <li>Alerts sent automatically at 90, 30, and 7 days before expiration.</li>
                <li>Urgent flagging in-app with color-coded urgency so nothing falls through.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Well data ────────────────────────────────────────────────── */}
      <section
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="wells-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="wells-heading">
            Well activity, right alongside your deal
          </h2>
          <p className={styles.sectionLead}>
            Know what's producing near the acreage before you commit. Mineral
            Flow AI pulls well records from state databases automatically when
            you upload a document.
          </p>
          <div className={styles.valGrid}>
            <div className={styles.valCard}>
              <strong>Texas RRC</strong>
              <p>
                API numbers and well locations by county via the Texas Railroad
                Commission public GIS — all 254 Texas counties covered.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>North Dakota NDIC</strong>
              <p>
                Operator, formation, and production data for ND wells via the
                North Dakota Industrial Commission — Bakken and beyond.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>Oklahoma OCC</strong>
              <p>
                Well records from the Oklahoma Corporation Commission — SCOOP,
                STACK, and Anadarko Basin coverage included.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>West Virginia DEP</strong>
              <p>
                Appalachian well data from the WV DEP — Marcellus and Utica
                shale plays covered statewide.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>Ohio DNR</strong>
              <p>
                Ohio oil and gas well records via the Ohio DNR DOGRM —
                Utica and conventional formations statewide.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Validation ───────────────────────────────────────────────── */}
      <section
        id="validation"
        className={styles.section}
        aria-labelledby="validation-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="validation-heading">
            Built for real mineral deals
          </h2>
          <p className={styles.sectionLead}>
            Tested against real documents, refined continuously. Conservative
            on claims — precise on execution.
          </p>
          <div className={styles.valGrid}>
            <div className={styles.valCard}>
              <strong>91%+</strong>
              <p>
                Directional accuracy on labeled mineral deal samples used in
                internal evaluation.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>Grounded</strong>
              <p>
                Outputs tied to extracted text — not free-form invention beyond
                what&apos;s in the file.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>Iterative</strong>
              <p>
                Models and rules evolve as we see more deeds, leases, and
                revenue statements in production.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── ROI ──────────────────────────────────────────────────────── */}
      <section
        id="roi"
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="roi-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="roi-heading">
            Why acquisition teams choose Mineral Flow AI
          </h2>
          <p className={styles.sectionLead}>
            Practical outcomes for land, acquisitions, and deal teams of any size.
          </p>
          <div className={styles.roiGrid}>
            <div className={styles.roiCard}>
              <h3>Move faster</h3>
              <p>
                Shrink first-pass review from hours to minutes. More deals
                evaluated, fewer bottlenecks in the queue.
              </p>
            </div>
            <div className={styles.roiCard}>
              <h3>Focus on better opportunities</h3>
              <p>
                Score and well data surface pursue-worthy deals before you
                commit senior time to full due diligence.
              </p>
            </div>
            <div className={styles.roiCard}>
              <h3>Never miss an expiration</h3>
              <p>
                Automated lease alerts mean your team always has time to
                renegotiate, renew, or act — not just react.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────── */}
      <section className={styles.finalCta} aria-labelledby="final-heading">
        <div className={styles.wrap}>
          <h2 id="final-heading">Send a deal. We&apos;ll run it.</h2>
          <p className={styles.subhead}>
            Want to see how it performs on a real document? Send over a deed,
            lease, division order, or revenue statement and we&apos;ll walk you
            through the output.
          </p>
          <div className={styles.ctaRow}>
            <a className={styles.btnPrimary} href={MAIL_DEMO}>
              Book a Demo
            </a>
            <a className={styles.btnSecondary} href={MAIL_CONTACT}>
              Contact Us
            </a>
          </div>
          <p className={styles.emailLine}>
            <a href="mailto:cbosher@mineralflowai.com">
              cbosher@mineralflowai.com
            </a>
          </p>
        </div>
      </section>

      <PublicFooter variant="landing" />
    </div>
  );
}

/* ── Icons ────────────────────────────────────────────────────────────── */

function IconDoc() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6M16 13H8M16 17H8M10 9H8"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconStar() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m12 2 2.06 6.35h6.67l-5.4 3.92 2.06 6.35L12 14.77l-5.4 3.92 2.06-6.35-5.4-3.92h6.67L12 2Z"
        stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconWell() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 2v4M12 18v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M2 12h4M18 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCurrency() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPipeline() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="7" width="4" height="10" rx="1" stroke="currentColor" strokeWidth="1.75" />
      <rect x="10" y="4" width="4" height="13" rx="1" stroke="currentColor" strokeWidth="1.75" />
      <rect x="18" y="9" width="4" height="8" rx="1" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

function ProductFrame({ title, caption }: { title: string; caption: string }) {
  return (
    <div className={styles.showcaseFrame}>
      <div className={styles.showcaseCap}>{title}</div>
      <div className={styles.showcaseInner}>
        <div className={styles.placeholderUi} role="img" aria-label={title}>
          {caption}
        </div>
      </div>
    </div>
  );
}
