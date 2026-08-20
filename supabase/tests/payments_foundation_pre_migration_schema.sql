-- supabase/tests/payments_foundation_pre_migration_schema.sql
--
-- Minimal schema additions required before applying Payments Foundation migration.
--
-- HISTORICAL CONTEXT:
-- These columns (currency, payment_date) were originally added to invoices by
-- 20260803150000_import_persistence_core.sql during normal application evolution.
--
-- VERIFICATION CONTEXT:
-- The targeted bootstrap verifier intentionally skips full historical replay to
-- avoid unrelated FK-drift failures. However, Payments Foundation requires these
-- specific columns to exist for:
-- - Legacy fixture seeding (payments_foundation_pre_migration_setup.sql)
-- - Currency invariant enforcement in record_payment()
-- - Payment KPI view reconstruction referencing i.payment_date
--
-- This file provides ONLY these two columns, nothing more.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS payment_date date;
