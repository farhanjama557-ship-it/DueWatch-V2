-- [SECTION: final-canonical-assertions begin]
-- ------------------------------------------------------------
-- Final canonical postconditions. Inlined by the assembler IMMEDIATELY
-- BEFORE the baseline's final `commit;`, so every assertion whose
-- failure means "convergence/construction did not succeed" executes
-- INSIDE the mutation transaction: a failure here rolls the entire
-- baseline back, for both fresh construction and legacy convergence.
--
-- Deliberately does NOT call duewatch_ops.unknown_client_foreign_keys():
-- that function's allowlist is part of the archived chain's historical
-- end-state and predates the import tables (the same fact that made
-- 20260811000000 non-replay-safe). Calling it here would misreport the
-- import tables' own FKs as unknown. The assertions below check expected
-- facts directly instead.
-- ------------------------------------------------------------

do $final_canonical_assertions$
declare
  v_fk_def text;
begin
  -- Invoice/client composite tenant FK, exact definition, validated.
  select pg_get_constraintdef(oid) into v_fk_def
  from pg_constraint
  where conrelid = 'public.invoices'::regclass
    and conname = 'invoices_user_id_client_id_fkey'
    and contype = 'f';
  if v_fk_def is null
    or v_fk_def not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_fk_def not like '%ON DELETE SET NULL (client_id)%' then
    raise exception 'FINAL ASSERTION FAILED: invoice/client composite tenant FK is not canonical';
  end if;

  -- Pending-only awaiting_signature uniqueness; legacy constraint gone.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.awaiting_signature'::regclass
      and conname = 'awaiting_signature_user_id_invoice_id_status_key'
  ) then
    raise exception 'FINAL ASSERTION FAILED: legacy awaiting_signature three-column unique still present';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'awaiting_signature'
      and indexname = 'awaiting_signature_one_pending_per_invoice'
  ) then
    raise exception 'FINAL ASSERTION FAILED: pending-only awaiting_signature unique index missing';
  end if;

  -- Canonical era tables exist.
  if exists (
    select 1 from (values
      ('autopilot_execution_claims'), ('payments'), ('payment_allocations'),
      ('import_runs'), ('import_batches'), ('import_rows'), ('import_events'),
      ('client_source_identities'), ('client_dedup_runs'),
      ('client_merge_candidates'), ('client_merge_audit'), ('autopilot_settings'),
      ('autopilot_rules')
    ) as expected(tablename)
    where to_regclass(format('public.%I', tablename)) is null
  ) then
    raise exception 'FINAL ASSERTION FAILED: one or more canonical public tables are missing';
  end if;

  -- Canonical RPCs exist.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('acquire_autopilot_execution_claim', 'resolve_autopilot_execution_claim',
       'record_payment', 'reverse_payment')
    having count(*) = 4
  ) then
    raise exception 'FINAL ASSERTION FAILED: canonical RPC set incomplete';
  end if;

  -- Canonical policies exist.
  if exists (
    select 1 from (values
      ('payments', 'payments_select_own'),
      ('payment_allocations', 'payment_allocations_select_own'),
      ('autopilot_execution_claims', 'autopilot_execution_claims_select_own'),
      ('autopilot_settings', 'autopilot_settings_own'),
      ('autopilot_rules', 'autopilot_rules_own')
    ) as expected(tablename, policyname)
    where not exists (
      select 1 from pg_policies p2
      where p2.schemaname = 'public'
        and p2.tablename = expected.tablename
        and p2.policyname = expected.policyname
    )
  ) then
    raise exception 'FINAL ASSERTION FAILED: one or more canonical policies are missing';
  end if;

  raise notice 'final canonical assertions: all passed (inside the mutation transaction, before commit)';
end
$final_canonical_assertions$;
-- [SECTION: final-canonical-assertions end]
