-- DueWatch security/availability hardening.
-- Add covering indexes for every currently unindexed public foreign key that
-- can become a hot path under tenant-scoped application traffic.

create index if not exists sec_fk_autopilot_execution_claims_invoice
  on public.autopilot_execution_claims(invoice_id);
do $optional_autopilot_rules_index$
begin
  if to_regclass('public.autopilot_rules') is not null then
    execute 'create index if not exists sec_fk_autopilot_rules_user on public.autopilot_rules(user_id)';
  end if;
end
$optional_autopilot_rules_index$;
create index if not exists sec_fk_awaiting_signature_invoice
  on public.awaiting_signature(invoice_id);
create index if not exists sec_fk_client_source_identities_user_client
  on public.client_source_identities(user_id, client_id);

create index if not exists sec_fk_dw_evidence_derived_from
  on public.dw_evidence_items(user_id, run_id, derived_from_key);
create index if not exists sec_fk_dw_evidence_invoice_scope
  on public.dw_evidence_items(user_id, invoice_id, client_id);
create index if not exists sec_fk_dw_intelligence_invoice_scope
  on public.dw_intelligence_runs(user_id, invoice_id, client_id);
create index if not exists sec_fk_dw_memory_derived_from
  on public.dw_memory_claims(user_id, derived_from_memory_id);
create index if not exists sec_fk_dw_memory_invoice_scope
  on public.dw_memory_claims(user_id, invoice_id, client_id);
create index if not exists sec_fk_dw_memory_evidence
  on public.dw_memory_evidence_links(user_id, evidence_id);
create index if not exists sec_fk_dw_proof_invoice_scope
  on public.dw_proof_events(user_id, invoice_id, client_id);
create index if not exists sec_fk_dw_tombstone_evidence
  on public.dw_tombstone_evidence_links(user_id, evidence_id);

create index if not exists sec_fk_events_invoice
  on public.events(invoice_id);
create index if not exists sec_fk_events_previous_action
  on public.events(previous_action_id);

create index if not exists sec_fk_import_batches_user_run
  on public.import_batches(user_id, run_id);
create index if not exists sec_fk_import_events_user
  on public.import_events(user_id);
create index if not exists sec_fk_import_events_user_run
  on public.import_events(user_id, run_id);
create index if not exists sec_fk_import_events_user_batch
  on public.import_events(user_id, batch_id);
create index if not exists sec_fk_import_events_user_row
  on public.import_events(user_id, row_id);

create index if not exists sec_fk_import_rows_client
  on public.import_rows(client_id);
create index if not exists sec_fk_import_rows_invoice
  on public.import_rows(invoice_id);
create index if not exists sec_fk_import_rows_user_run
  on public.import_rows(user_id, run_id);
create index if not exists sec_fk_import_rows_user_batch
  on public.import_rows(user_id, batch_id);
create index if not exists sec_fk_import_rows_user_client
  on public.import_rows(user_id, client_id);
create index if not exists sec_fk_import_rows_user_invoice
  on public.import_rows(user_id, invoice_id);

create index if not exists sec_fk_invoices_user_client
  on public.invoices(user_id, client_id);
create index if not exists sec_fk_payments_recorded_by
  on public.payments(recorded_by);
create index if not exists sec_fk_payments_reversed_by
  on public.payments(reversed_by);

-- Remove exact duplicates already reported by the hosted database advisor.
-- Keep the *_id_idx variants as the canonical names.
drop index if exists public.clients_user_idx;
drop index if exists public.invoices_client_idx;
drop index if exists public.invoices_user_idx;
drop index if exists public.line_items_inv_idx;
