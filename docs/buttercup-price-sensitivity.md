# Buttercup prototype: focused price/cost report addition

Scope: existing EngineDecision page and Decision Record PDF only. No migration, worker, title parser, forecast formula or entry/exit formula changes. Apply this commit after Claude's pending title/evidence fixes; do not replace those changes. Remote main observed at f173e547; its changes are title-only, with no overlap in these files.

Adds the 13 oil assumptions $40–$100 in $5 steps to page and PDF using the existing provider, entryAnalysis and exitAnalysis. Each row shows year-one net cash, nonnegative purchase ceiling, hold cash, exit value and IRR. Gas/NGL and selected costs remain fixed. Prices are realized flat assumptions, not WTI strip quotes. Exit is the remaining cash-flow PV at the selected hold date. Existing evidence gates remain unchanged.

Operator/county are displayed with the existing basin cost basis. Optional lower/base/higher cost presets are explicitly illustrative −20%/0/+20% around that location baseline; custom numbers use existing editable fields and report provenance. These are NOT actual operator cost observations. Real operator-specific cost datasets are not supplied or implemented by this checkpoint.

Validation: 25 focused tests (provider, decision layer, sensitivity), TypeScript. No live authenticated run or new PDF visual acceptance claimed.

Acceptance before October 6: finish the current title run; reconcile all document outcomes and sections 25/36/37; upload/reopen the 12-API Buttercup package through the signed-in app; select a cost scenario and custom costs; verify all 13 rows appear in the generated PDF and match the screen. Confirm title gaps remain visible, per-page citations remain present, and cost/price edits cannot erase title blockers. No claims of live completion until this is done.
