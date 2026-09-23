# Resume title retrieval from the app

Base: deployed 891d356. Frontend/API change only; no migration or worker rebuild.

The title job page now shows Resume retrieval for awaiting_tract_confirmation,
awaiting_documents and failed jobs. This uses the existing authenticated retry
route and queues the existing job; it does not create a second title scope.
Confirmed tracts, documents, index records and attempt history remain intact.

The route checks account ownership and performs a conditional update against
both status and updated_at. If another operation wins, it returns 409 and asks
the user to reload. Running retrieval, ingestion, analysis, published complete
and cancelled states are not resumable through this action. Failed-job recovery
retains its three-attempt limit; explicit user resumes of review-paused research
are permitted beyond that limit. Worker query/document bounds remain unchanged.

Live acceptance after deploying frontend: open Buttercup job 31f9fe66, click
Resume retrieval, and verify that the same job moves to pending/searching_records.
Check the persisted precise tract searches and any resulting documents. No direct
SQL status change is required. An already-cached successful/empty query may remain
cached according to the worker's existing policy; this is not a force-refresh.

Local verification includes route tests for ownership filtering, absent auth,
forbidden states, failed retry limit and concurrent updates. This does not assert
live authenticated acceptance, document ingestion or a completed GOLD decision.
