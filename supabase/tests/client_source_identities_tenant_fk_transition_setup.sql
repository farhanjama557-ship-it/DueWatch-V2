-- Hosted-transition regression setup: downgrades this already-corrected
-- database (supabase/schema.sql plus the corrected
-- 20260726000000_canonical_clients.sql have already run earlier in this CI
-- pipeline) back to the EXACT old repository shape client_source_identities
-- actually has on hosted staging right now: a single-column
-- client_id -> clients(id) FK, the existing RLS policies, and no composite
-- FK. Nothing else about the table (RLS policies, indexes, columns) is
-- touched by this fix and it already matches staging, so only the
-- constraint needs to be swapped back rather than reconstructing the whole
-- table from scratch.
--
-- Opens one explicit transaction that stays open across every -f file
-- passed to this same psql invocation (this setup, the forward migration
-- applied twice, then the assertions file) and is rolled back by the last
-- file, so none of this leaks into the rest of the CI run — the same
-- multi-file, single-connection, explicit begin/rollback pattern already
-- used by invoice_client_tenant_preflight_setup.sql.
begin;

alter table public.client_source_identities
  drop constraint client_source_identities_user_id_client_id_fkey;
alter table public.client_source_identities
  add constraint client_source_identities_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete cascade;

do $preconditions$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_user_id_client_id_fkey'
  ) then
    raise exception 'Hosted-transition setup failed: composite FK is still present';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_client_id_fkey'
      and contype = 'f'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE'
      and convalidated
      and not condeferrable
  ) then
    raise exception 'Hosted-transition setup failed: exact old single-column FK is missing or does not match';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'client_source_identities'
      and policyname = 'client_source_identities_select_own'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'client_source_identities'
      and policyname = 'client_source_identities_insert_own'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'client_source_identities'
      and policyname = 'client_source_identities_update_own'
  ) then
    raise exception 'Hosted-transition setup failed: expected RLS policies are missing';
  end if;
end
$preconditions$;
