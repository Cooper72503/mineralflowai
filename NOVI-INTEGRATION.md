# MineralFlow decision layer — Novi integration preparation

The owner’s boundary is: Novi supplies data and analytics; MineralFlow turns those inputs, regulatory evidence and reviewed title into a traceable acquisition work product. The acquisition professional reviews exceptions and makes the final decision. Texas is the current regulatory scope; OCC/NMOCD are not implemented by this milestone.

## Executable work delivered

`frontend/lib/trrc/decision-layer/partner-input.ts` defines a MineralFlow-owned interchange contract. It is not a representation of Novi’s actual API. An adapter must map an agreed Novi export/API payload into it while preserving source evidence.

Supported observations are well monthly production, complete/partial/unknown lease membership, and gross-well monthly forecasts with explicit forecast ID, model version, generation timestamp and scenario. Each observation references a retained source snapshot using a JSON pointer. Inputs require source URL, provider, retrieval timestamp and SHA-256 of the parsed payload. Hashes detect changed snapshots; they do not authenticate the provider or replace original-file retention.

Normalization validates Texas APIs, units, nonnegative reported volumes, missing values and duplicate well months. Supported oil units are bbl/Mbbl and gas units Mcf/MMcf. Missing values stay null. Unknown units, broken citations and invalid payloads fail explicitly.

Reconciliation compares the same reporting months and requires a complete cited lease population that includes the subject. It never compares only the subject well with a multi-well regulator lease. Oil and gas are assessed independently. A match, contradiction and insufficient evidence are different states. The percentage threshold is supplied with a named policy, never invented. Zero denominators are handled explicitly. Lease membership completeness remains a provider assertion requiring separate verification where decision-material.

The royalty scenario consumes a selected partner forecast. It does not refit it. It uses the existing monthly discount conversion and rational-fraction implementation. NRI, realized commodity prices, taxes, position deductions, horizon, discount rate, margin criterion and asking price are explicit user assumptions. NRI is labeled unverified; generic working-interest operating costs are not imposed on a royalty position. Missing forecast months or phases prevent valuation. The price comparison is conditional on those assumptions and does not declare title, ownership or closing readiness verified.

## Reproduce the two integration examples

After installing frontend and worker dependencies as described in `STANDALONE-GOLD.md`, run from the repository root:

```sh
npm run decision:reconcile --prefix frontend -- ../benchmarks/partner-fixtures/matched.json ../audit-work/partner-matched.json
npm run decision:reconcile --prefix frontend -- ../benchmarks/partner-fixtures/scenario.json ../audit-work/partner-scenario.json
npm test --prefix frontend -- lib/trrc/__tests__/partner-reconciliation.test.ts lib/trrc/__tests__/partner-scenario.test.ts
```

Both fixture files are synthetic, explicitly marked as such; they are not live Novi or RRC observations. The command accepts one JSON object containing `partner`, `regulator`, `policy`, optional `api`, and optional `assumptions`. The regulator capture and explicit API/assumption API must agree. Output retains both evidence sets, reconciliation and conditional scenario calculations. Invalid input exits nonzero. An honest missing-data/contradiction outcome is a valid calculation result, not a completed acquisition decision.

## Remaining integration gates

| Gate | Current state |
|---|---|
| Cited production and forecast input | Implemented proposed interchange; actual Novi mapping unverified |
| Same-scope regulator reconciliation | Implemented and tested, including contradictions and missing data |
| Conditional royalty scenario and price comparison | Implemented for explicit user assumptions; no verified ownership claim |
| Reviewed title → ownership/NRI | Not connected; title read, cache and publication defects identified and still require fixes |
| Novi completion, geology, spacing and cost input | Mapping/contract not implemented |
| Measured exceptions versus unpriced blockers | Not yet connected to the integrated decision output |
| Scenario confidence and closing rules | Not yet implemented end to end |
| GOLD PDF/UI/bulk integration | New integration calculations are not yet wired into those surfaces |
| Live Novi acceptance | No actual payload, credentials or supported field mapping supplied |

Before a live connection can be claimed, agree on identifier granularity, well/lease membership and effective dates, gross/net and phase/unit semantics, production revision behavior, forecast scenario/model versions, data timestamps, source attribution and access terms. This list is a technical mapping requirement, not a request to rebuild Novi’s analytics.

## GOLD2 integration cycle

The MineralFlow-owned `NoviAdapter` separates authenticated transport from an agreed response mapper. Unconfigured feeds, timeouts, cancellations, wrong-well responses and invalid evidence return explicit failure states. The adapter does not guess Novi endpoints or claim a live connection. Its current normalized data contract covers production, lease membership and forecasts; completion/geology/cost payload mapping remains outstanding.

`linkReviewedMineralPosition` selects one canonical party/holding/tract from the existing title graph and checks confirmed API-to-tract association, reviewed source scope, document hashes and exact fraction arithmetic. This implementation supports acreage-based pooled mineral royalties. It does not infer owners from API numbers, divide collective holdings, or substitute working-interest calculations.

`evaluateGold2Economics` reuses the cashflow engine with that recomputed NRI for commodity scenarios and price sensitivity. Buyer margin may be explicitly absent: modeled value can still be computed, but maximum buy price is withheld. The GOLD2 draft rejects valuation periods preceding its as-of month.

Run `npm run decision:gold2-draft -- INPUT.json OUTPUT.json` from `frontend` with the `Gold2Input` payload. This is an integrated development work product, explicitly `draft_not_validated`; remaining mappings, risk review and chart acceptance must be completed before a GOLD2 report can pass. Run `npm run gold2:benchmark` to retain exact failures for all ten captured cases and update the GOLD report count in `PIPELINE-STATUS.md`.


## Executed report handoff (2026-09-11)

The adapter accepts cited `well_measurement` observations as well as production, membership and forecast records. Supported measurements include formation tops, TVD/reference elevation, porosity/saturation, net/gross interval, pressure gradient, spacing density, parent/child, interference and completion quantities. Values remain provider observations, with explicit units and reference data; API depth is not substituted for TVD. This is the MineralFlow interchange, not a claimed native Novi API schema.

An authenticated GOLD2 report POST can carry a reviewed position, partner bundle, reconciliation policy, explicit economics, forecast selection and reviewed evidence scenarios. API/retained sources and the account-owned title analysis cannot be replaced by the request. Reconciliation requires evidenced complete lease membership over identical reporting months. All absent inputs remain explicit.
