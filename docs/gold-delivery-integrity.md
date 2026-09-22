# GOLD delivery integrity

Apply this checkpoint after dc2bcab. The cumulative patch also includes 4b05ad3
(title ingestion integrity); do not apply that change twice. If it is already
present, apply only the new commit patch.

Deploy frontend and rebuild the worker dist from the full repository, then ship
that complete dist. Shared title/position loaders are bundled into the report
worker. No migration or new credentials are required.

Individual reports now stop on title query failures (503), distinguish position
query failures (503) from changed analysis versions (409), and recompute the
assembled draft before delivery. Active pending/resolving/searching/ingesting/
analyzing title scopes withhold any old publication. A legitimate absent title
still produces an explicit insufficient-data draft.

Verification: 867 frontend tests passed, including title outage, five active
processing stages, ownership outage and concurrent analysis version changes.
These are automated regressions, not live acquisition acceptance.

After deploy, use a signed-in test account to request both JSON and PDF for a
completed run. Check that a real missing title remains explicitly unavailable.
On a disposable research job with an existing publication, rerun ingestion and
verify GOLD no longer attaches that old publication while processing is active.
Do not simulate outages or mutate real acquisition evidence in production.

Limits: this is not a transactional snapshot across all report reads. It does
not invalidate every older analysis after every document/tract edit, automate
ingestion, connect internal forecasts to GOLD, or certify a title position.
Those remain separate acceptance requirements. GOLD acquisition count: 0/10.
