-- supabase/tests/promise_to_pay_pre_migration_schema.sql
--
-- Minimal schema additions required before applying the Promise-to-Pay
-- Foundation migration in the TARGETED (checkpoint-only) verifier.
--
-- HISTORICAL CONTEXT:
-- Both of these were originally added by real historical migrations:
-- - invoices.currency: 20260803150000_import_persistence_core.sql
-- - invoices_user_id_id_uidx: 20260803150000_import_persistence_core.sql
--
-- VERIFICATION CONTEXT:
-- The targeted bootstrap verifier intentionally skips full historical replay
-- (see scripts/ci/verify-promise-to-pay.sh) to stay fast and avoid unrelated
-- FK-drift failures. Promise-to-Pay Foundation requires both of these to
-- exist: the currency column (a promise snapshots its invoice's currency)
-- and the unique index (the promises table's composite tenant FK targets
-- it). This file provides ONLY these two objects, nothing more.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS currency text;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_user_id_id_uidx
  ON public.invoices (user_id, id);
