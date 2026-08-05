-- Add purchase_price to trrc_due_diligence_runs so the Economic Evaluation
-- section can compute real IRR and payout months (economics.ts) against a
-- proposed deal price instead of always leaving them null. Optional and
-- nullable — most runs still won't set it, and the report already handles
-- that case with an honest "not computed" disclosure.

alter table trrc_due_diligence_runs
  add column if not exists purchase_price numeric;
