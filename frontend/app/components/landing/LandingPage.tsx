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

      <section className={styles.hero} aria-labelledby="hero-heading">
        <div className={styles.wrap}>
          <div className={styles.heroGrid}>
            <div>
              <span className={styles.eyebrow}>Mineral intelligence</span>
              <h1 id="hero-heading">
                Evaluate Mineral Deals in Minutes, Not Hours
              </h1>
              <p className={styles.subhead}>
                Upload a deed, lease, division order, or revenue document and
                get a deal score, financial output, and clear reasoning in
                minutes.
              </p>
              <p className={styles.trustLine}>
                91%+ accuracy on real mineral deals • Built for landmen,
                acquisition teams, and mineral buyers
              </p>
              <div className={styles.ctaRow}>
                <a className={styles.btnPrimary} href={MAIL_DEMO}>
                  Book a Demo
                </a>
                <Link className={styles.btnSecondary} href="/signup">
                  Run a Deal
                </Link>
              </div>
              <div className={styles.chips} aria-hidden>
                <span className={styles.chip}>Deal score</span>
                <span className={styles.chip}>Financial output</span>
                <span className={styles.chip}>Confidence & reasoning</span>
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
                Deals per year — cost and delay add up quickly
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="solution-heading">
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="solution-heading">
            Mineral Flow AI turns documents into decisions
          </h2>
          <p className={styles.sectionLead}>
            Structured extraction, scoring, and transparency so your team can
            move from document intake to a clear pursue or skip recommendation.
          </p>
          <div className={styles.featureGrid}>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconDoc />
              </div>
              <div>
                <h3>Ownership & terms</h3>
                <p>
                  Extracts ownership, acreage, legal description, and key lease
                  or deed terms from uploaded files.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconStar />
              </div>
              <div>
                <h3>Deal score & reasoning</h3>
                <p>
                  Scores the deal with pursue vs. skip reasoning tied to what was
                  found in the document.
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
                  When revenue or production data is present, see financial
                  output alongside the score.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconConfidence />
              </div>
              <div>
                <h3>Confidence</h3>
                <p>
                  Confidence is shown with results so teams know what to trust
                  before the next step.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

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
            Four steps from upload to a decision-ready view.
          </p>
          <div className={styles.steps}>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>1</div>
              <h3>Upload</h3>
              <p>Deed, lease, division order, or revenue statement.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>2</div>
              <h3>Extract</h3>
              <p>Key fields, text, and structure pulled from the document.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>3</div>
              <h3>Score</h3>
              <p>Deal score with reasoning and confidence indicators.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>4</div>
              <h3>Decide</h3>
              <p>Move forward, dig deeper, or pass — with evidence in one place.</p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="product"
        className={styles.section}
        aria-labelledby="product-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="product-heading">
            Inside the product
          </h2>
          <p className={styles.sectionLead}>
            Representative areas of the application — built for clarity and
            speed in real workflows.
          </p>
          <div
            className={`${styles.showcaseGrid} ${styles.showcaseGridWide}`}
          >
            <ProductFrame
              title="Upload"
              caption="Drag-and-drop or select documents for processing."
            />
            <ProductFrame
              title="Extraction & confidence"
              caption="Structured fields with confidence where the model is less certain."
            />
            <ProductFrame
              title="Deal score"
              caption="Score and pursue vs. skip reasoning in one view."
            />
            <ProductFrame
              title="Financial output"
              caption="Economics when revenue or production data is available."
            />
            <ProductFrame
              title="Dashboard"
              caption="Pipeline visibility across deals and documents."
            />
          </div>
        </div>
      </section>

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
            When statements include usable revenue or production information, the
            platform can surface monthly and annual figures, a rough valuation
            range, and confidence — with methodology called out alongside the
            numbers.
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
                <span>Confidence</span>
                <strong>Medium</strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="confidence-heading">
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="confidence-heading">
            Confidence you can actually understand
          </h2>
          <p className={styles.sectionLead}>
            Confidence reflects how directly information appeared in the source
            material — not a marketing score.
          </p>
          <div className={styles.confGrid}>
            <div className={styles.confCard}>
              <h3>Higher confidence</h3>
              <ul>
                <li>Direct values and labels found clearly in the document.</li>
                <li>Stable extraction with fewer gaps or ambiguities.</li>
              </ul>
            </div>
            <div className={styles.confCard}>
              <h3>Lower confidence</h3>
              <ul>
                <li>
                  Data inferred from partial production text or incomplete
                  tables.
                </li>
                <li>
                  Methodology notes and warnings shown next to affected fields.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section
        id="validation"
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="validation-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="validation-heading">
            Validated on real mineral deals
          </h2>
          <p className={styles.sectionLead}>
            We test against real documents and refine extraction and scoring
            continuously. Statements below are intentionally conservative.
          </p>
          <div className={styles.valGrid}>
            <div className={styles.valCard}>
              <strong>91%+</strong>
              <p>
                Directional accuracy on labeled mineral deal samples used in
                internal evaluation (not a guarantee for every document type).
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>Grounded</strong>
              <p>
                Outputs are tied to extracted text and fields — not free-form
                invention beyond the file.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>Iterative</strong>
              <p>
                Models and rules evolve as we see more deeds, leases, and
                revenue statements in the wild.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="roi"
        className={styles.section}
        aria-labelledby="roi-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="roi-heading">
            Why teams use it
          </h2>
          <p className={styles.sectionLead}>
            Practical outcomes for land, acquisitions, and deal teams.
          </p>
          <div className={styles.roiGrid}>
            <div className={styles.roiCard}>
              <h3>Move faster</h3>
              <p>
                Shrink first-pass review from hours to minutes so deals do not
                stall in the queue.
              </p>
            </div>
            <div className={styles.roiCard}>
              <h3>Focus on better opportunities</h3>
              <p>
                Prioritize pursue-worthy deals with score and reasoning before
                you commit senior time.
              </p>
            </div>
            <div className={styles.roiCard}>
              <h3>Reduce wasted labor</h3>
              <p>
                Spend fewer hours on documents that are unlikely to clear the
                bar.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.finalCta} aria-labelledby="final-heading">
        <div className={styles.wrap}>
          <h2 id="final-heading">Send a deal. We’ll run it.</h2>
          <p className={styles.subhead}>
            Want to see how it performs on a real document? Send over a deed,
            lease, division order, or revenue statement and we’ll walk you
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
            <a href="mailto:cbosher@mineralflowai.com">cbosher@mineralflowai.com</a>
          </p>
        </div>
      </section>

      <PublicFooter variant="landing" />
    </div>
  );
}

function IconDoc() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6M16 13H8M16 17H8M10 9H8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconStar() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m12 2 2.06 6.35h6.67l-5.4 3.92 2.06 6.35L12 14.77l-5.4 3.92 2.06-6.35-5.4-3.92h6.67L12 2Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCurrency() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconConfidence() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M12 8v4l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProductFrame({
  title,
  caption,
}: {
  title: string;
  caption: string;
}) {
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
