-- ============================================================================
-- DueWatch — ONE-TIME legacy-live → canonical convergence script.
--
-- THIS IS NOT A MIGRATION. It must never live in supabase/migrations/ and
-- must never be executed by Supabase migration tooling on a fresh
-- environment. Fresh environments are constructed exclusively by
-- supabase/migrations/20260822000000_canonical_baseline.sql via db reset /
-- db push. This script exists solely to move the VERIFIED legacy
-- production baseline to exactly that canonical state.
--
-- Input state contract (verified against production 2026-08-22):
--   public tables: profiles, clients, invoices, line_items, reminders,
--   events, awaiting_signature, autopilot_runs, autopilot_settings,
--   autopilot_rules — and NOTHING ELSE from the post-baseline era.
--   invoices.client_id carries the legacy single-column FK to clients(id)
--   ON DELETE CASCADE; awaiting_signature carries the legacy
--   unique(user_id, invoice_id, status).
--
-- Classification (fail closed):
--   * verified legacy state            → converge
--   * already canonical                → safe no-op re-run
--   * anything else                    → RAISE before changing anything
--
-- How it converges: the canonical baseline itself is included verbatim
-- (\ir). Its statements are deterministic on the legacy state: additive
-- objects are created if missing, the legacy single-column client FK is
-- replaced by the composite tenant FK, and the legacy three-column
-- awaiting_signature uniqueness is replaced by the pending-only partial
-- unique index. The baseline's own internal preflights (cross-tenant
-- data checks, fail-closed catalog assertions) protect every transition.
--
-- Transactionality: the included baseline opens exactly one explicit
-- transaction (begin; ... commit;) spanning the entire convergence.
-- Execute with psql and ON_ERROR_STOP (see the production runbook):
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
--     -f supabase/convergence/20260822_legacy_live_to_canonical.sql
-- A failure anywhere inside the baseline transaction rolls the whole
-- convergence back; the preflight below runs before any change is made.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PHASE 0 — preflight classification. No mutation happens in this phase.
--
-- The baseline below is a FRESH-DATABASE CONSTRUCTOR by design; it is not
-- re-entry safe (its internal postconditions assert the exact world each
-- section built, which a completed database no longer matches). Therefore
-- an already-canonical database short-circuits to a clean no-op HERE —
-- by refusing to re-apply — rather than by re-running the baseline.
-- The classification is computed in plain SQL (psql \gset) so the script
-- can exit before touching anything.
--
--   verified legacy baseline -> converge (PHASE 1)
--   already canonical        -> clean no-op exit 0 (this phase)
--   anything else            -> RAISE before any change (this phase)
-- ---------------------------------------------------------------------------

select (
  -- era objects present at all?
  exists (select 1 from pg_namespace where nspname = 'duewatch_ops')
  or exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename in (
      'client_source_identities', 'client_dedup_runs', 'client_merge_candidates',
      'client_merge_audit', 'import_runs', 'import_batches', 'import_rows',
      'import_events', 'autopilot_execution_claims', 'payments', 'payment_allocations'
    )
  )
) as era_objects_exist,
(
  -- fully canonical already?
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_user_id_client_id_fkey'
      and contype = 'f' and convalidated
  )
  and exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'awaiting_signature'
      and indexname = 'awaiting_signature_one_pending_per_invoice'
  )
  and not exists (
    select 1 from pg_constraint
    where conrelid = 'public.awaiting_signature'::regclass
      and conname = 'awaiting_signature_user_id_invoice_id_status_key'
  )
  and exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename in (
      'autopilot_execution_claims', 'payments', 'payment_allocations',
      'import_runs', 'client_source_identities'
    )
    having count(*) = 5
  )
  and exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'acquire_autopilot_execution_claim'
  )
  and exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_payment'
  )
  and exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payments'
      and policyname = 'payments_select_own'
  )
  and exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'autopilot_settings'
      and policyname = 'autopilot_settings_own'
  )
) as already_canonical
\gset

\if :already_canonical
\echo 'convergence preflight: database is already canonical; nothing to do (clean no-op).'
\quit
\endif

\if :era_objects_exist
\echo 'convergence preflight: refusing an unknown state (post-baseline-era objects exist but the database is not fully canonical).'
\echo 'This script only accepts the verified legacy baseline or an already-canonical database.'
\echo 'Restore from the pre-convergence backup or investigate manually.'
do $fail_closed_unknown_state$
begin
  raise exception 'unknown state: post-baseline-era objects exist but the database is not fully canonical; refusing to converge';
end
$fail_closed_unknown_state$;
\quit
\endif

do $preflight_legacy_shape$
begin
  -- The verified legacy baseline must have its ten known public tables and
  -- nothing from the post-baseline era.
  if not (
    select bool_and(to_regclass(format('public.%I', t)) is not null)
    from unnest(array[
      'profiles', 'clients', 'invoices', 'line_items', 'reminders',
      'events', 'awaiting_signature', 'autopilot_runs',
      'autopilot_settings', 'autopilot_rules'
    ]) as t
  ) then
    raise exception 'unknown state: one or more expected legacy tables are missing; this is not the verified legacy baseline';
  end if;
  raise notice 'convergence preflight: verified legacy baseline confirmed (no post-baseline-era objects present)';
end
$preflight_legacy_shape$;

-- ---------------------------------------------------------------------------
-- PHASE 1 — the canonical baseline, verbatim. On the legacy state this
-- creates every missing canonical object and performs the two documented
-- state transitions (invoice/client composite tenant FK; pending-only
-- awaiting_signature uniqueness). Its own internal preflights and
-- assertions fail closed on anything it does not recognize.
-- ---------------------------------------------------------------------------
\ir ../migrations/20260822000000_canonical_baseline.sql

-- ---------------------------------------------------------------------------
-- PHASE 2 — canonical postconditions. Read-only verification that the
-- convergence reached exactly the canonical end-state.
-- ---------------------------------------------------------------------------
do $postconditions$
declare
  v_definition text;
begin
  select pg_get_constraintdef(oid) into v_definition
  from pg_constraint
  where conrelid = 'public.invoices'::regclass
    and conname = 'invoices_user_id_client_id_fkey'
    and contype = 'f';
  if v_definition is null
    or v_definition not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_definition not like '%ON DELETE SET NULL (client_id)%' then
    raise exception 'postcondition failed: invoice/client composite tenant FK is not canonical';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.awaiting_signature'::regclass
      and conname = 'awaiting_signature_user_id_invoice_id_status_key'
  ) then
    raise exception 'postcondition failed: legacy awaiting_signature three-column unique constraint still present';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'awaiting_signature'
      and indexname = 'awaiting_signature_one_pending_per_invoice'
  ) then
    raise exception 'postcondition failed: pending-only awaiting_signature unique index missing';
  end if;

  if to_regclass('public.autopilot_execution_claims') is null
     or to_regclass('public.payments') is null
     or to_regclass('public.payment_allocations') is null
     or to_regclass('public.import_runs') is null
     or to_regclass('public.client_source_identities') is null then
    raise exception 'postcondition failed: canonical era tables missing after convergence';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'acquire_autopilot_execution_claim'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_payment'
  ) then
    raise exception 'postcondition failed: canonical RPCs missing after convergence';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payments'
      and policyname = 'payments_select_own'
  ) and exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'autopilot_settings'
      and policyname = 'autopilot_settings_own'
  ) then
    raise notice 'convergence postconditions: all canonical checks passed';
  else
    raise exception 'postcondition failed: canonical policies missing after convergence';
  end if;
end
$postconditions$;
