-- [SECTION: final-canonical-assertions begin]
-- ------------------------------------------------------------
-- Final canonical postconditions. Inlined by the assembler IMMEDIATELY
-- BEFORE the baseline's final `commit;`, so every assertion whose
-- failure means "convergence/construction did not succeed" executes
-- INSIDE the mutation transaction: a failure here rolls the entire
-- baseline back, for both fresh construction and legacy convergence.
--
-- Deliberately does NOT call duewatch_ops.unknown_client_foreign_keys():
-- that function's final definition (refreshed by the archived
-- 20260803021842) is NOT complete for the post-import schema — its
-- allowlist predates the import tables and does not contain
-- import_rows' composite/foreign-key pairs referencing clients and
-- invoices (the same fact that made 20260811000000 non-replay-safe).
-- Calling it here would misreport the import tables' own FKs as unknown.
-- The assertions below check expected facts directly instead.
--
-- DORMANT LIMITATION (documented, intentional): execute_client_dedup()
-- calls unknown_client_foreign_keys() as its blocking gate, and on the
-- canonical state that gate returns the import_rows FKs as "unknown".
-- Client dedup must not be enabled until import_rows reference behavior
-- during client/invoice merge/delete is reviewed and proven. The current
-- unknown-FK gate intentionally fails closed. (Regression-proven by
-- PROOF 15 in run_canonical_proofs.sh.)
-- ------------------------------------------------------------

do $final_canonical_assertions$
declare
  v_fk_def text;
  v_fk_valid boolean;
  v_idx_def text;
begin
  -- Invoice/client composite tenant FK: exact definition AND validated
  -- (convalidated = true asserted explicitly, not just implied by name).
  select pg_get_constraintdef(oid), con.convalidated into v_fk_def, v_fk_valid
  from pg_constraint con
  where conrelid = 'public.invoices'::regclass
    and conname = 'invoices_user_id_client_id_fkey'
    and contype = 'f';
  if v_fk_def is null
    or v_fk_def not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_fk_def not like '%ON DELETE SET NULL (client_id)%' then
    raise exception 'FINAL ASSERTION FAILED: invoice/client composite tenant FK is not canonical';
  end if;
  if v_fk_valid is distinct from true then
    raise exception 'FINAL ASSERTION FAILED: invoice/client composite tenant FK is not validated (convalidated=%)', v_fk_valid;
  end if;

  -- Pending-only awaiting_signature uniqueness; legacy constraint gone.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.awaiting_signature'::regclass
      and conname = 'awaiting_signature_user_id_invoice_id_status_key'
  ) then
    raise exception 'FINAL ASSERTION FAILED: legacy awaiting_signature three-column unique still present';
  end if;
  -- The pending-only index is asserted by its FULL definition (unique,
  -- exact key columns (user_id, invoice_id), predicate equivalent to
  -- status = 'pending') — not merely by its name existing. A
  -- same-name/wrong-definition index is rejected.
  select pg_get_indexdef(i.oid) into v_idx_def
  from pg_index x
  join pg_class i on i.oid = x.indexrelid
  join pg_class t on t.oid = x.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relname = 'awaiting_signature'
    and i.relname = 'awaiting_signature_one_pending_per_invoice';
  if v_idx_def is distinct from
     'CREATE UNIQUE INDEX awaiting_signature_one_pending_per_invoice ON public.awaiting_signature USING btree (user_id, invoice_id) WHERE (status = ''pending''::text)' then
    raise exception 'FINAL ASSERTION FAILED: pending-only awaiting_signature unique index missing or not the exact canonical definition: %', coalesce(v_idx_def, '<missing>');
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

  -- Canonical RPC EXISTENCE/completeness check (presence of the four
  -- function names only — signatures/definitions/ACLs are not compared
  -- here; definition fidelity is proven structurally by proofs 3+4).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('acquire_autopilot_execution_claim', 'resolve_autopilot_execution_claim',
       'record_payment', 'reverse_payment')
    having count(*) = 4
  ) then
    raise exception 'FINAL ASSERTION FAILED: canonical RPC set incomplete';
  end if;

  -- Canonical policy EXISTENCE/completeness check (presence of the five
  -- (table, policy) pairs only — policy definitions are not compared
  -- here).
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
