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
              <span className={styles.eyebrow}>Working interest underwriting platform</span>
              <h1 id="hero-heading">
                Underwriting-Grade Deal Analysis in Minutes
              </h1>
              <p className={styles.subhead}>
                Enter an API number or RRC lease ID. Mineral Flow AI pulls 36 months
                of TRRC production, runs Arps decline curve analysis, builds a
                multi-scenario NPV model, and returns an offer range — verified
                against live EIA pricing and basin benchmarks.
              </p>
              <p className={styles.trustLine}>
                Live TRRC data &nbsp;·&nbsp; Arps DCA with terminal decline &nbsp;·&nbsp;
                NPV10 / offer range &nbsp;·&nbsp; Six-dimension risk score &nbsp;·&nbsp; Evidence-tracked per field
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
                <span className={styles.chip}>Arps DCA</span>
                <span className={styles.chip}>NPV model</span>
                <span className={styles.chip}>Offer range</span>
                <span className={styles.chip}>Risk score</span>
                <span className={styles.chip}>Document extraction</span>
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
            fitting a decline curve, modeling NPV across price scenarios, verifying
            LOE against basin benchmarks, and checking compliance — all before
            you write an LOI. Most teams do this in a spreadsheet, by hand, one
            deal at a time.
          </p>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <div className={styles.statValue}>8–12 hrs</div>
              <div className={styles.statLabel}>
                Time to complete a proper WI evaluation with TRRC pull, DCA, and NPV model
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
                <h3>Live TRRC production — 36 months</h3>
                <p>
                  Pulls monthly production directly from the Texas Railroad Commission
                  by API number or RRC lease ID. Every month is classified: active,
                  downtime, restart, flush, or incomplete — with calendar gaps
                  preserved for accurate decline modeling.
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
                <h3>Multi-scenario NPV model</h3>
                <p>
                  Stress / Base / Strip / Upside price decks anchored to live EIA WTI
                  and Henry Hub, with basin-specific differentials applied. Computes
                  NPV10, NPV15, IRR, payout months, offer range (low/mid/high), and
                  breakeven oil price — including severance tax, ad valorem, workover reserve,
                  and SWD disposal costs.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconShield />
              </div>
              <div>
                <h3>Six-dimension risk score</h3>
                <p>
                  Scores production risk, financial risk, compliance, plugging liability,
                  operator quality, and data completeness. Returns a pursue / review / pass
                  recommendation with specific red, yellow, and green flags — not a number
                  without reasoning.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconDoc />
              </div>
              <div>
                <h3>AI document extraction</h3>
                <p>
                  Processes LOE statements, run tickets, division orders, joint interest
                  billings, workover AFEs, W-1/W-2 completion reports, and equipment lists.
                  Extracts monthly production, line-item costs, NRI/WI, water cut, formation
                  depth, and completion data — with physical bounds validation before any
                  number reaches the model.
                </p>
              </div>
            </div>
            <div className={styles.featureCard}>
              <div className={styles.featureIcon} aria-hidden>
                <IconCheck />
              </div>
              <div>
                <h3>Evidence tracking &amp; offer gate</h3>
                <p>
                  Every diligence field shows its data source: TRRC structured data,
                  TRRC imaged record, seller document, or assumption. An offer gate
                  blocks the recommendation until Production, Division Orders, LOE,
                  and Workover History are verified — preventing a number from being
                  mistaken for a fact.
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
            From API number to offer range in four steps
          </h2>
          <p className={styles.sectionLead}>
            The platform runs the full evaluation automatically. You provide the
            identifiers and documents; it does the rest.
          </p>
          <div className={styles.steps}>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>1</div>
              <h3>Identify the asset</h3>
              <p>Enter the API number, RRC lease ID, or operator name. No manual TRRC searching required.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>2</div>
              <h3>Production pulled automatically</h3>
              <p>36 months of TRRC production fetched, classified, and analyzed for downtime, restarts, and TRRC reporting lag.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>3</div>
              <h3>Upload operator documents</h3>
              <p>LOE statements, division orders, workover records, run tickets. AI extracts every structured field with bounds validation.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>4</div>
              <h3>Review the full report</h3>
              <p>Decline curve, NPV model, offer range, risk score, evidence sources, and a prioritized document request list for anything still missing.</p>
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
                <span>NPV10 — base deck</span>
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
                <span>Risk score</span>
                <strong>3.8 / 10 — Pursue</strong>
              </div>
            </div>
          </div>
          <div className={styles.noteBox} style={{ marginTop: "1.5rem" }}>
            Economics are suppressed when NRI and WI are both unverified — an unverified interest
            fraction can move the offer range by 30–50%. The platform blocks the offer recommendation
            and generates a specific document request list until ownership is confirmed.
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
            Railroad Commission automatically, in parallel, in under 18 seconds.
          </p>
          <div className={styles.confGrid}>
            <div className={styles.confCard}>
              <h3>Production &amp; completion records</h3>
              <ul>
                <li>36 months of monthly oil and gas production by lease ID</li>
                <li>API-to-district-code resolution via wellbore lookup</li>
                <li>W-2 completion data: formation, depth, perforations, casing, tubing</li>
                <li>ICE field inspection records: visit date, pass/fail, deficiency notes</li>
              </ul>
            </div>
            <div className={styles.confCard}>
              <h3>Compliance &amp; environmental</h3>
              <ul>
                <li>Violations by API number or operator — open vs. resolved status</li>
                <li>Injection well records: SWD permit, MIT test currency, max permitted pressure</li>
                <li>Orphan well risk flagged against bond amount on file</li>
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
                Production, formation, compliance, and inspection data pulled directly
                from the Railroad Commission. Highest-quality public record source for Texas wells.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>TRRC Imaged</strong>
              <p>
                W-1 / W-2 scanned records, field inspection forms, and permit filings.
                Extracted from imaged documents where structured data is unavailable.
              </p>
            </div>
            <div className={styles.valCard}>
              <strong>Seller Documents</strong>
              <p>
                LOE statements, run tickets, division orders, and workover AFEs uploaded
                by the operator. AI-extracted with physical bounds validation and
                cross-checked against basin benchmarks.
              </p>
            </div>
          </div>
          <div className={styles.noteBox} style={{ marginTop: "1.5rem" }}>
            The offer gate is locked until Production History, Division Orders / Ownership, LOE Statements,
            and Workover History are each sourced from TRRC structured data or a verified seller document —
            not from a model estimate or assumption. If a field is still missing, the platform generates
            the specific document request and names who to ask.
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
              <p>Frio / Yegua / Austin Chalk and six additional Texas basins. Each with EIA 2022-sourced LOE, differential, and decline benchmarks.</p>
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
            production analysis, DCA fit, NPV model, and offer range together.
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
