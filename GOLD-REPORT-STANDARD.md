# MineralFlow GOLD report standard

This is the release acceptance standard for the API-to-decision workflow. The
approved GOLD 2.0 sample remains the visual reference; exact visual equivalence
must be checked against that file, not against the legacy TRRC PDF. Its source
PDF is not currently present in this checkout. This document does not certify
that the implementation meets the standard.

## One analysis, one work product

A single API and a submitted API batch use the same analysis workflow. The final
PDF is a deal-level report with per-lease detail and per-API evidence references.
One JSON companion retains all inputs, calculations, citations and execution
states. The buyer never joins separate title, economics and diligence reports.
Duplicate lease production and value must appear once in deal totals. Unresolved
input rows remain in the report and limit conclusions explicitly.

## Presentation order

1. Decision summary: acquisition posture, price assessment, purchase ceiling,
   modeled exit, holding cash flow, price-dependent returns, five most material
   unresolved issues, and evidence currency. Clearly separate conditional model
   results from a supported acquired-interest conclusion.
2. Asset scope: submitted APIs, matched leases, lease membership, offering scope,
   duplicate handling and unresolved identities. Show a cited map where available.
3. Production and forecast: reported history and dated model curves, separated
   by lease; missing months, selected fit window, interventions/step changes,
   model parameters and stopping conditions. Gross volumes are not well allocation
   or seller production. A forecast cap is not proven economic life or reserves.
4. Purchase and exit: base/downside/upside values, purchase ceiling, holding cash,
   modeled exit, sensitivity charts and disclosed assumptions. Show units and
   valuation dates. Missing asking price must not suppress purchase ceiling or
   modeled exit; price comparison and entry-dependent returns remain unavailable.
5. Title and ownership: matched subject tracts, relevant instrument chronology,
   interests and reservations, cited ownership branches, reviewed position, gaps
   and exact next actions. Index leads and interpreted instruments stay distinct.
6. Regulatory, engineering and geology findings: prioritize decision materiality;
   retain contradictions, source failures and what could change the recommendation.
7. Evidence appendix: source references, retrieval status/time, calculation methods,
   assumptions and review history. Detail supports the decision pages rather than
   burying them in a repeated source-by-source printout.

Use readable type, consistent spacing and units, clearly labeled charts and
compact tables. Status colors must agree with their text. No ornamental maps or
charts with fabricated data. No blank fields or unexplained dashes. Render and
inspect populated, incomplete-data and multi-lease PDFs before release.

## Evidence and retrieval acceptance

- Every material field is cited evidence, reproducible calculation, explicitly
  labeled assumption, or unavailable with a specific reason and next action.
- Retrieval has a bounded search plan: identity variants, legal-description
  normalization, relevant permit/unit references and instrument cross-references.
  Exhausted queries, failed queries and queries never attempted are distinct.
- No-hit searches do not establish absence of a conveyance or ownership interest.
- Completion of a worker job does not establish complete title or acquisition
  readiness. Operator identity does not establish WI/NRI.
- Data gaps limit the affected calculation/conclusion; they do not erase supported
  findings elsewhere. Errors are never promoted to clean coverage or zero values.
- Source access and review requirements remain honest. Do not promise complete
  ownership or a buy conclusion from every syntactically valid API.

## Release gates

For each live benchmark, submit through the actual authenticated app, let the
workers finish, reopen the saved analysis and download the final work product.
Check every reported value against retained input and calculation output. Verify
same-lease deduplication, account isolation, title scope/version binding, restart
recovery, assumption persistence and PDF/JSON agreement. Evaluate legitimate
missing-data cases separately from fully supported acquisition decisions.

GOLD reports validated stays 0/10 until real complete acquisition cases meet
these gates. Unit-test counts and PDF rendering success do not increase it.

## Current implementation gaps

Combined package PDF, unified report navigation, complete public-title ingestion
and recovery, verified operated-interest linkage, live price-deck handoff, and
live benchmark acceptance remain outstanding. Internal Arps/cash-flow/exit
engines already exist and should be reused. The PDF sample must be restored for
page-by-page visual acceptance. Do not substitute a polished mock for live output.
