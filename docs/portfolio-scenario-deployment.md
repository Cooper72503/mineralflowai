# Package scenario engine handoff

Deploy the frontend after the existing migration 034; no new migration or worker
change is required. This builds on deployed base 0fe8ce7 and preserves its flip module.

## Existing engines reused

- `forecastNetCashFlowSeries` fits each unique lease stream with the existing Arps
  engine. An optional operating-input argument separates NRI revenue from WI costs;
  omitted inputs preserve the prior gross screening behavior.
- `evaluateFlipCashFlows` extracts the existing hold/exit/profit arithmetic so the
  portfolio can sum lease cash flows and apply the purchase price/capital once.
- The package maximum entry discounts hold cash and exit proceeds at the explicitly
  stated buyer return and subtracts entry capital once.
- Monthly fixed expenses are entered on an acquired-interest package basis and
  include water handling. Additional variable LOE/workover costs are WI-weighted.
- Terminal liability is deducted once at the last forecast month. Exit uses remaining
  modeled PV-10 times the supplied multiple, less fees on positive proceeds only.
- Positive IRR is withheld for multiple cash-flow sign changes; no arbitrary root
  or negative-exit selling-fee credit is published.

## User workflow

Open the existing portfolio review. Enter asking price and the seller's stated
inventory count. Enable the conditional oil-only acquisition/exit scenario and
complete its interest, price, cost, capital, liability and buyer-return inputs.
Editable defaults are explicit model assumptions, not retrieved asset facts.

Save the review. `conditionalEconomics` contains the disclosed inputs, source
pointers, fits, excluded-history/bridge counts, monthly cash flows, three price
scenarios, maximum entry, exit, returns and remaining forecast volumes. They are
conditional outputs, never verified ownership or certified reserves. Reopening a
saved snapshot preserves its inputs/results in JSON; the scenario-entry form is
for a new calculation and must be explicitly enabled and completed again.

Forecast readiness is computed without financial inputs. Fitting uses the latest
contiguous complete suffix ending at the last reported month, retaining all earlier
history in evidence. Missing internal months are not compressed; trailing unreported
months are not zeros. Current/future months are excluded from completed-month sums
and disclosed with pointers to retained original rows.

No automatic restart rate or waterflood intervention response is inferred. An
included stream that cannot be forecast blocks the whole package scenario. History
age must meet the explicitly selected maximum. A model cash-flow pass never clears
inventory or title blockers. Claimed-versus-listed counts must be reconciled before
portfolio scenario execution.

## Verification after deployment

1. Open a completed portfolio with a known complete production history. Enter an
   explicit scenario and verify it is saved under the owner and reopens unchanged.
2. Compare source citations and unique-stream sums. Purchase price, fixed package
   expenses, initial capital and terminal liability must each be counted once.
3. Submit missing/invalid interests, stale history, a short/gapped history or a last
   reported zero oil month; verify explicit withholding instead of an invented fit.
4. Verify the current-month unreported RRC row does not invalidate all earlier history.
5. Compare a single-asset flip before/after with normal positive-exit assumptions.
   Existing math is preserved except the stated negative-exit fee / ambiguous IRR fixes.

Local live captures used the actual existing worker fetchers for 49 API identity
queries and two lease-production queries. They were not authenticated worker jobs
and did not rerun every diligence source. Private captures and package results are
excluded from this code checkpoint. The GOLD2 drafts passed structural validation;
this does not count as completed acquisition GOLD acceptance.
