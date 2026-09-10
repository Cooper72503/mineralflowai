-- ─────────────────────────────────────────────────────────────────────────────
-- Acquisition Decision Layer
--
-- The title chain answers "who owns what, and what is unresolved". This
-- migration carries the inputs needed to answer the acquisition question on
-- top of it: at what price does the deal work, what would change that, and
-- what must be resolved before closing.
--
-- Deliberately nullable throughout. A job with no ownership basis or price
-- deck configured yields posture INSUFFICIENT_DATA, which is the correct
-- answer rather than a defaulted one. No asking price is ever defaulted;
-- null means ASKING PRICE NOT PROVIDED and the report shows thresholds
-- instead of a comparison.
-- ─────────────────────────────────────────────────────────────────────────────

alter table title_research_jobs
  -- Evaluated position, in exact fractions rather than decimals.
  add column if not exists evaluated_position_label text,
  add column if not exists mineral_fraction_numerator bigint,
  add column if not exists mineral_fraction_denominator bigint,
  add column if not exists lease_royalty_numerator bigint,
  add column if not exists lease_royalty_denominator bigint,
  add column if not exists gross_tract_acres numeric,
  add column if not exists proration_unit_acres numeric,
  -- Price deck and return criteria.
  add column if not exists oil_price_usd_bbl numeric,
  add column if not exists gas_price_usd_mcf numeric,
  add column if not exists oil_differential_usd_bbl numeric,
  add column if not exists gas_differential_usd_mcf numeric,
  add column if not exists required_margin_pct numeric,
  add column if not exists underwrite_against text,          -- base | downside
  -- Never defaulted. Null renders as "ASKING PRICE NOT PROVIDED".
  add column if not exists asking_price_usd numeric,
  -- Vendor-supplied remaining volumes and decline, when a feed is connected.
  add column if not exists remaining_oil_bbl numeric,
  add column if not exists remaining_gas_mcf numeric,
  add column if not exists annual_decline_pct numeric;

-- The decision record travels with the analysis version that produced it, so
-- a stored posture can always be traced to the rule version and inputs behind
-- it rather than being recomputed under newer rules.
alter table title_analyses
  add column if not exists decision_json jsonb,
  add column if not exists decision_posture text,            -- PROCEED | CONDITIONAL_PROCEED | HOLD_FOR_DILIGENCE | PASS | INSUFFICIENT_DATA
  add column if not exists decision_rule_version text,
  add column if not exists decision_rule_id text,
  add column if not exists closing_readiness text,           -- READY_FOR_FINAL_REVIEW | CONDITIONAL | NOT_READY | INSUFFICIENT_EVIDENCE
  add column if not exists decision_confidence text;         -- HIGH | MEDIUM | LOW | INSUFFICIENT

create index if not exists title_analyses_posture_idx on title_analyses(decision_posture);
