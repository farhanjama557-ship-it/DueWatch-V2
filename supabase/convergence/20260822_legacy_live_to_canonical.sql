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
--   * anything else — including an already-converged database —
--                                      → RAISE before changing anything
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
-- ONE-TIME TOOL CONTRACT (adversarial-review hardened):
--
--   VERIFIED LEGACY STATE            -> converge (PHASE 1)
--   ANY POST-BASELINE / ALREADY-
--   MUTATED STATE (including an
--   already-converged database)      -> REFUSE, require investigation
--
-- There is deliberately NO "already canonical -> no-op" shortcut: proving
-- full canonical structural equivalence here would mean duplicating the
-- entire canonical fingerprint, and a name-based sample check would
-- silently bless drifted FKs, indexes, columns, function bodies, grants,
-- triggers, or policies. A second invocation after a successful
-- convergence fails closed below WITHOUT changing anything — acceptable
-- and safer than a weak idempotency classification.
--
-- All final canonical success assertions live INSIDE the baseline's
-- mutation transaction (sections/20260822000002_final_canonical_
-- assertions.sql, inlined immediately before its commit), so a failed
-- assertion rolls the entire convergence back. PHASE 2 of this script is
-- informational post-commit verification only.
-- ---------------------------------------------------------------------------

-- Post-baseline-era objects present at all -> refuse before any mutation.
do $preflight_refuse_mutated$
begin
  if exists (select 1 from pg_namespace where nspname = 'duewatch_ops') or exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename in (
      'client_source_identities', 'client_dedup_runs', 'client_merge_candidates',
      'client_merge_audit', 'import_runs', 'import_batches', 'import_rows',
      'import_events', 'autopilot_execution_claims', 'payments', 'payment_allocations'
    )
  ) then
    raise exception 'unknown/already-mutated state: post-baseline-era objects exist. This one-time convergence tool accepts ONLY the verified legacy baseline; a re-run after successful convergence is expected to fail closed here without changing anything. Investigate manually (or restore from the pre-convergence backup).';
  end if;
end
$preflight_refuse_mutated$;

-- The verified legacy baseline must have its ten known public tables.
do $preflight_legacy_shape$
begin
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
-- PHASE 2 — informational post-commit checks. These duplicate a subset of
-- the FINAL canonical assertions that already executed INSIDE the
-- baseline transaction (before its commit); they are a human-visible
-- confirmation only and are NOT rollback-protected success gates. The
-- rollback-protected contract lives in the baseline itself.
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
