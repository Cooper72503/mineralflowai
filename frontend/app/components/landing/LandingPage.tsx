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
  "mailto:demo@mineralflowai.com?subject=Book%20a%20demo%20%E2%80%94%20Mineral%20Flow%20AI";
const MAIL_CONTACT =
  "mailto:demo@mineralflowai.com?subject=Mineral%20Flow%20AI%20%E2%80%94%20Contact";

export function LandingPage() {
  return (
    <div className={`${inter.className} ${styles.page}`}>
      <PublicHeader variant="landing" />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className={styles.hero} aria-labelledby="hero-heading">
        <div className={styles.wrap}>
          <div className={styles.heroGrid}>
            <div>
              <span className={styles.eyebrow}>Texas public records due diligence platform</span>
              <h1 id="hero-heading">
                Underwriting-Grade Deal Analysis in Minutes
              </h1>
              <p className={styles.subhead}>
                Enter an API number, lease ID, or operator name. MineralFlow AI queries
                every applicable Texas Railroad Commission public record source, runs
                Arps decline curve analysis, models multi-scenario economics, and
                returns an acquisition scorecard and offer range — with every field
                traced to its source record and every gap disclosed, not guessed.
              </p>
              <p className={styles.trustLine}>
                Full TRRC retrieval &nbsp;·&nbsp; Arps DCA &nbsp;·&nbsp;
                Multi-scenario economics &nbsp;·&nbsp; Offset Analytics &nbsp;·&nbsp; Acquisition Scorecard &nbsp;·&nbsp; Evidence-tracked per field
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
                <span className={styles.chip}>Production analysis</span>
                <span className={styles.chip}>Offset Analytics</span>
                <span className={styles.chip}>Acquisition Scorecard</span>
                <span className={styles.chip}>Arps DCA</span>
                <span className={styles.chip}>Economic model</span>
                <span className={styles.chip}>Offer range</span>
                <span className={styles.chip}>Evidence-first</span>
              </div>
            </div>
            <div className={styles.heroMock} aria-hidden>
              <div className={styles.mockChrome}>
                <span className={styles.mockDot} />
                <span className={styles.mockDot} />
                <span className={styles.mockDot} />
              </div>
              <div className={styles.mockBody}>
                <div className={styles.mockLabel}>Offer range — base deck</div>
                <div className={styles.mockScore}>$284K – $412K</div>
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
            WI underwriting takes too long and depends on too few people
          </h2>
          <p className={styles.sectionLead}>
            A complete working interest evaluation means pulling TRRC production,
            fitting a decline curve, modeling PV-10/PV-15 across price scenarios,
            verifying LOE against basin benchmarks, and checking compliance — all
            before you write an LOI. Most teams do this in a spreadsheet, by hand,
            one deal at a time.
          </p>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <div className={styles.statValue}>8–12 hrs</div>
              <div className={styles.statLabel}>
                Time to complete a proper WI evaluation with TRRC pull, DCA, and economic model
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>$1,500+</div>
              <div className={styles.statLabel}>
                Fully-loaded cost per deal evaluation when engineer or landman time is allocated
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>One person</div>
              <div className={styles.statLabel}>
                Most acquisition teams rely on one engineer who knows the spreadsheet — a single-point bottleneck
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Solution ─────────────────────────────────────────────────── */}
      <section className={styles.section} aria-labelledby="solution-heading">
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="solution-heading">
            The full underwriting stack, automated
          </h2>
          <p className={styles.sectionLead}>
            Every layer of a working interest due diligence — from raw TRRC
            production through a signed offer recommendation — in a single platform.
          </p>
          <div className={styles.featureGrid}>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconWell />
              </div>
              <div>
                <h3>Full TRRC production history</h3>
                <p>
                  Pulls the monthly production record from the Texas Railroad
                  Commission by API number or lease ID, alongside wellbore identity,
                  operator/P-5 status, compliance, injection, oil proration, drilling
                  permits, and lease inventory — 18 public record sources queried
                  automatically, every attempt logged.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconChart />
              </div>
              <div>
                <h3>Arps decline curve analysis</h3>
                <p>
                  Fits exponential, hyperbolic, and harmonic models. Selects best
                  by SSE with b-factor penalty for over-fitting. Applies industry-standard
                  terminal decline switch to prevent hyperbolic tails from projecting
                  unrealistic economic lives. Returns EUR, R², and 60-month forward projections.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconCurrency />
              </div>
              <div>
                <h3>Multi-scenario economic model</h3>
                <p>
                  Stress / Base / Strip / Upside price decks, with basin-specific
                  differentials applied. Computes PV-10, PV-15, offer range
                  (low/mid/high), and breakeven oil price — including severance tax,
                  ad valorem, workover reserve, and SWD disposal costs. IRR and payout
                  months compute when a proposed purchase price is supplied; otherwise
                  the report says so explicitly rather than guessing.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconShield />
              </div>
              <div>
                <h3>Acquisition Scorecard</h3>
                <p>
                  Scores mechanical integrity, regulatory compliance, operator profile,
                  and development activity, weighted into a single deal-quality score
                  with a pursue / review / pass recommendation — each dimension shows
                  its reasoning, not just a number.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconDoc />
              </div>
              <div>
                <h3>Offset Analytics</h3>
                <p>
                  True geodesic-radius offset well search, analog similarity scoring,
                  and composite type-curve construction — used to proxy-value
                  undeveloped tracts against nearby comparable completions.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconCheck />
              </div>
              <div>
                <h3>Evidence-first reporting</h3>
                <p>
                  Every diligence field shows its data source and the record it was
                  pulled from. When a source can&apos;t be reached, or production is
                  ramping instead of declining, or ownership data doesn&apos;t exist for
                  this well, the report says so explicitly — it will not force a number
                  it can&apos;t back.
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
            From identifier to full report in minutes
          </h2>
          <p className={styles.sectionLead}>
            The platform runs the full retrieval and analysis automatically. You
            provide the identifier; it queries every applicable public record source,
            fits the decline curve, and builds the report.
          </p>
          <div className={styles.steps}>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>1</div>
              <h3>Identify the asset</h3>
              <p>Enter the API number, lease ID, operator name, or legal description. No manual TRRC searching required.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>2</div>
              <h3>Public records retrieved automatically</h3>
              <p>Every applicable TRRC source is queried in sequence — production, compliance, injection, permits, and more — with every attempt logged, success or failure.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>3</div>
              <h3>Analysis runs on what was retrieved</h3>
              <p>Decline curve fit, multi-scenario economics, offset analytics, and the acquisition scorecard are built from the records actually found — not assumed.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>4</div>
              <h3>Review and download the full report</h3>
              <p>PDF report, Excel workbook, CSV exports, and a ZIP evidence archive. Any source that couldn&apos;t be reached or record that wasn&apos;t found is disclosed, not omitted.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Economics output ─────────────────────────────────────────── */}
      <section
        id="economics"
        className={styles.section}
        aria-labelledby="economics-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="economics-heading">
            Every number that goes into an offer decision
          </h2>
          <p className={styles.sectionLead}>
            The economics model runs the same math a petroleum engineer would —
            including the parts most acquisition spreadsheets skip.
          </p>
          <div className={styles.finGrid}>
            <div>
              <div className={styles.featureGrid} style={{ gridTemplateColumns: "1fr", gap: "0.75rem" }}>
                <div className={styles.featureCard}>
                  <div className={styles.featureIcon} aria-hidden><IconChart /></div>
                  <div>
                    <h3>Stabilized production rate</h3>
                    <p>Trailing average of active months only — excludes downtime, restart transition, and potentially incomplete TRRC reports.</p>
                  </div>
                </div>
                <div className={styles.featureCard}>
                  <div className={styles.featureIcon} aria-hidden><IconWell /></div>
                  <div>
                    <h3>Instantaneous decline at current time</h3>
                    <p>For hyperbolic wells, uses D(t) = Di/(1+b·Di·t) rather than the historical t=0 rate — prevents overstating future decline speed for mature wells.</p>
                  </div>
                </div>
                <div className={styles.featureCard}>
                  <div className={styles.featureIcon} aria-hidden><IconCurrency /></div>
                  <div>
                    <h3>All-in cost structure</h3>
                    <p>Severance tax, ad valorem, workover reserve, SWD disposal (when water cut is known), and LOE cross-checked against EIA basin benchmarks.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className={styles.finMock}>
              <h4>Example output — Permian Midland, 120 BBL/mo</h4>
              <div className={styles.finRow}>
                <span>Stabilized rate</span>
                <strong>120 BBL/mo (active months)</strong>
              </div>
              <div className={styles.finRow}>
                <span>Decline model</span>
                <strong>Hyperbolic · b=0.82 · R²=0.94</strong>
              </div>
              <div className={styles.finRow}>
                <span>Monthly decline rate</span>
                <strong>1.8%/mo effective</strong>
              </div>
              <div className={styles.finRow}>
                <span>EUR (to 5 BBL limit)</span>
                <strong>8,400 BBL remaining</strong>
              </div>
              <div className={styles.finRow}>
                <span>PV-10 — base deck</span>
                <strong className={styles.finHighlight}>$342,000</strong>
              </div>
              <div className={styles.finRow}>
                <span>Breakeven oil price</span>
                <strong>$28.40 / BBL</strong>
              </div>
              <div className={styles.finRow}>
                <span>Offer range</span>
                <strong>$215K – $290K – $342K</strong>
              </div>
              <div className={styles.finRow}>
                <span>Acquisition score (0–100)</span>
                <strong>82 — Pursue</strong>
              </div>
            </div>
          </div>
          <div className={styles.noteBox} style={{ marginTop: "1.5rem" }}>
            Economics are computed on a gross (100%) interest basis. This product
            does not collect or verify mineral or working-interest ownership
            fractions — confirm NRI/WI independently before relying on any dollar
            figure for an actual offer.
          </div>
        </div>
      </section>

      {/* ── TRRC & Compliance ─────────────────────────────────────────── */}
      <section
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="trrc-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="trrc-heading">
            TRRC data pulled automatically — not copy-pasted
          </h2>
          <p className={styles.sectionLead}>
            Every Texas underwriting pulls the full regulatory picture from the
            Railroad Commission automatically, in parallel, in minutes.
          </p>
          <div className={styles.confGrid}>
            <div className={styles.confCard}>
              <h3>Production &amp; identity records</h3>
              <ul>
                <li>Monthly oil and gas production by API number or lease ID</li>
                <li>API-to-district-code resolution via wellbore lookup</li>
                <li>Drilling permits (W-1), lease inventory, and oil proration filings</li>
                <li>Imaged document packets where structured data isn&apos;t available</li>
              </ul>
            </div>
            <div className={styles.confCard}>
              <h3>Compliance &amp; environmental</h3>
              <ul>
                <li>Violations by API number or operator — open vs. resolved status</li>
                <li>Injection-storage permit records: UIC number, well/lease/field identity, operator</li>
                <li>Orphan well program status checked automatically; operator bond standing verified via P-5 registration</li>
                <li>Multi-well lease attribution warning when TRRC aggregate covers multiple wellbores</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Evidence & verification ───────────────────────────────────── */}
      <section
        id="evidence"
        className={styles.section}
        aria-labelledby="evidence-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="evidence-heading">
            Every field shows where the number came from
          </h2>
          <p className={styles.sectionLead}>
            A deal report is only as useful as the data behind it. Every diligence
            field carries its evidence source — and the platform tells you exactly
            what documents to request to upgrade a weak source to a verified one.
          </p>
          <div className={styles.valGrid}>
            <div className={styles.valCard}>
              <strong>TRRC Structured</strong>
              <p>
                Production, compliance, injection, and permit data pulled directly
                from the Railroad Commission. Highest-quality public record source for Texas wells.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>TRRC Imaged</strong>
              <p>
                Scanned document packets and permit filings, retrieved where
                structured data isn&apos;t available for a given source.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>Disclosed Gap</strong>
              <p>
                When a source can&apos;t be reached, returns no applicable record, or
                doesn&apos;t exist for this well, the report says so explicitly —
                never silently substituted with an estimate.
              </p>
            </div>
          </div>
          <div className={styles.noteBox} style={{ marginTop: "1.5rem" }}>
            Every source attempt — success, failure, or not-applicable — is logged and
            shown in the report&apos;s coverage summary, not just the ones that returned data.
          </div>
        </div>
      </section>

      {/* ── Permit Tracker ───────────────────────────────────────────── */}
      <section
        id="permit-tracker"
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="permit-tracker-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="permit-tracker-heading">
            Permit Tracker — know the moment a new well is filed
          </h2>
          <p className={styles.sectionLead}>
            Built for service companies and acquisition teams who need to move on
            new drilling activity before the rest of the market hears about it —
            live New Drill (W-1) filings from the Railroad Commission, watched by
            county, with a text the moment one hits.
          </p>
          <div className={styles.featureGrid}>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconWell />
              </div>
              <div>
                <h3>Full basin coverage</h3>
                <p>
                  Every Permian Basin county — Midland and Delaware sub-basins — and
                  every Eagle Ford county, watched at once. Not a handful of the
                  busiest counties; the whole play.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconBell />
              </div>
              <div>
                <h3>SMS alerts</h3>
                <p>
                  Pick the counties your team operates in and get a text the moment
                  a new-drill permit is filed there — operator, lease, well number,
                  no manual searching or waiting for word to get around.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconPhone />
              </div>
              <div>
                <h3>Operator contact, right on the permit</h3>
                <p>
                  Every result carries the operator&apos;s registered TRRC contact
                  number, sourced from the Railroad Commission&apos;s own public
                  operator directory — so a lead doesn&apos;t sit for a day while
                  someone tracks down who to call.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconCheck />
              </div>
              <div>
                <h3>A real exclude list</h3>
                <p>
                  Search and hide the operators you don&apos;t service from your
                  results and alerts, built from a real roster of operators
                  confirmed active in these basins — not a static, generic list.
                </p>
              </div>
            </div>
          </div>
          <div className={styles.noteBox} style={{ marginTop: "1.5rem" }}>
            Runs on the same live TRRC retrieval engine behind the due diligence
            platform above. Currently rolling out to a limited group of service
            companies and acquisition teams.
          </div>
          <div className={styles.ctaRow} style={{ marginTop: "1.5rem" }}>
            <a className={styles.btnPrimary} href={MAIL_DEMO}>
              Book a Demo
            </a>
            <Link className={styles.btnSecondary} href="/pricing">
              Request Access
            </Link>
          </div>
        </div>
      </section>

      {/* ── Basin intelligence ─────────────────────────────────────────── */}
      <section
        className={`${styles.section} ${styles.sectionAlt}`}
        aria-labelledby="basins-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="basins-heading">
            Basin benchmarks built into every evaluation
          </h2>
          <p className={styles.sectionLead}>
            LOE is cross-checked against the expected range for the basin. Decline rate
            is compared to the typical rate for the play. If the numbers don&apos;t
            match, the platform flags it before the offer is written.
          </p>
          <div className={styles.valGrid}>
            <div className={styles.valCard}>
              <strong>Permian Basin</strong>
              <p>Midland and Delaware sub-basins. LOE $7.50–$20/BOE. Typical decline 2.5–3.0%/mo. Oil differential –$3.50 to –$4.00/BBL.</p>
            </div>
            <div className={styles.valCard}>
              <strong>Eagle Ford</strong>
              <p>Oil window and gas/condensate window. LOE $6–$16/BOE. Typical decline 4.5–5.0%/mo. Faster decline, lower disposal costs.</p>
            </div>
            <div className={styles.valCard}>
              <strong>West Texas Conventional</strong>
              <p>Spraberry / Wolfcamp conventional. LOE $12–$32/BOE. Typical decline 1.2%/mo. Long-lived stripper wells with higher per-unit operating costs.</p>
            </div>
            <div className={styles.valCard}>
              <strong>East Texas / Haynesville</strong>
              <p>Cotton Valley and Haynesville formations. LOE $10–$25/BOE. High salt water disposal costs. Strong Midcontinent gas infrastructure.</p>
            </div>
            <div className={styles.valCard}>
              <strong>Barnett Shale</strong>
              <p>Mature shale play. LOE $14–$30/BOE driven by compression and well age. Typical decline 2.0%/mo.</p>
            </div>
            <div className={styles.valCard}>
              <strong>Gulf Coast &amp; others</strong>
              <p>Frio / Yegua / Austin Chalk and six additional Texas basins, each with a documented reference range for LOE, differential, and decline.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── ROI ──────────────────────────────────────────────────────── */}
      <section
        id="roi"
        className={styles.section}
        aria-labelledby="roi-heading"
      >
        <div className={styles.wrap}>
          <h2 className={styles.sectionTitle} id="roi-heading">
            What changes when underwriting runs at software speed
          </h2>
          <p className={styles.sectionLead}>
            The same rigor as a 25-year veteran petroleum engineer — without the
            8-hour turnaround or the single-point dependency.
          </p>
          <div className={styles.roiGrid}>
            <div className={styles.roiCard}>
              <h3>More deals evaluated</h3>
              <p>
                Run a complete underwriting in minutes instead of a day. Evaluate
                the full opportunity set, not just the deals that fit the queue.
              </p>
            </div>
            <div className={styles.roiCard}>
              <h3>Better data discipline</h3>
              <p>
                Every number is source-tagged. LOE is benchmarked. Decline rates
                are sanity-checked against basin typical. The platform flags what
                a veteran would flag — before you sign anything.
              </p>
            </div>
            <div className={styles.roiCard}>
              <h3>Consistent offer methodology</h3>
              <p>
                The same DCA model, cost structure, and evidence standards on every
                deal — whether it&apos;s your first this week or your fifteenth.
                No more spreadsheet drift.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────── */}
      <section className={styles.finalCta} aria-labelledby="final-heading">
        <div className={styles.wrap}>
          <h2 id="final-heading">Send us an API number. We&apos;ll run it live.</h2>
          <p className={styles.subhead}>
            Want to see the full output on a real Texas well before committing?
            Send an API number or RRC lease ID and we&apos;ll walk through the
            production analysis, DCA fit, economic model, and offer range together.
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
            <a href="mailto:demo@mineralflowai.com">
              demo@mineralflowai.com
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

function IconChart() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <polyline
        points="22 12 18 12 15 21 9 3 6 12 2 12"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
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

function IconShield() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 11l3 3L22 4"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9Z"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M13.73 21a2 2 0 0 1-3.46 0"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPhone() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92Z"
        stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}
