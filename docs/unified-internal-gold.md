# MineralFlow internal lease engines into GOLD

Base: origin audit/main 9008c0c, merged without file changes. No migration or
new dependency. Deploy the frontend and full-repository-built worker dist.

## What executes

Single API: the existing GOLD report path now builds a reconciled RRC lease
record, fits the existing Arps model, and retains dated gross lease oil forecast
months. No Novi payload or economics assumptions are required for oil screening.
A six-month maximum history age is the disclosed screening default. No missing
production is made zero and no restart rate is invented.

The report download area accepts an asking price and explicit conditional
operating assumptions. POST report sends internalLeaseSettings {askingPriceUsd,
scenario}. Existing forecastNetCashFlowSeries and evaluateFlipCashFlows execute
inside GOLD. The PDF includes lease forecast graphics, maximum entry, exit and
forecast volumes; JSON retains monthly cash flows, source references and inputs.
The oil-only UI explicitly excludes gas. The server schema also supports
reported gas when that phase is complete. Prices are user inputs, not labeled
as a live EIA or Novi price deck. No economics formulas were replaced.

Package: assumptions and asking price now travel with the original atomic
package submission, so the existing durable worker calculates economics without
a second manual economics job. Request identity includes those options. Saved
package download now returns one GOLD Decision Record JSON containing shared
lease production/economics once, title/ownership for every member, all per-well
GOLD records, decision blockers and the retained evidence snapshot. Delivery
recomputes saved outputs, checks membership and evidence consistency, and rejects
modified or obsolete snapshots with 409. Existing gold2-json remains available.

Verification: 873 frontend tests pass, including real PDF rendering of synthetic
inputs. TypeScript, clean Next production build and full worker build pass.

## Acceptance

- Submit a new API package with explicitly reviewed scenario inputs. Let the
  workers finish without leaving a browser open. Download GOLD Decision Record.
- Verify two APIs on one lease produce one stream and one economic calculation.
- Confirm title analysis and reviewed mineral position appear when actually
  available; assumed operated WI/NRI must not be presented as reviewed ownership.
- For a single run, enable scenario inputs in its report area and download PDF.
  Compare the dated forecast, cash flows, maximum entry and exit with JSON from
  the same POST body using ?format=gold2-json.
- Old saved GOLD records predate this additive contract extension. Start a new
  analysis when current validation asks for regeneration. Do not overwrite old
  immutable evidence snapshots or reuse an old idempotency key with new inputs.

## Boundaries

Package combined delivery in this checkpoint is JSON; single-run integrated
GOLD delivery is PDF and JSON. It does not yet provide one combined package PDF.
Public-document retrieval, ingestion, tract matching and reviewed title remain
necessary and can still stop for review. This change does not add automatic OCR
scheduling/recovery or establish operated seller WI/NRI from instruments. The
existing reviewed position is mineral/royalty scoped; it cannot authorize an
operated-asset purchase. Conditional scenario values therefore do not change an
unsupported acquisition posture to BUY. Geological/reserve classifications are
not inferred from a decline fit. No real production acceptance was executed here.

GOLD reports validated: 0/10 complete real acquisition decisions.
