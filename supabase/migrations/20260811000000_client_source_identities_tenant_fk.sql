-- Forward migration for the verified staging tenant-integrity gap:
-- client_source_identities.client_id was only a single-column FK to
-- clients(id), proving the referenced client exists but not that it
-- belongs to the same tenant as user_id. An authenticated caller could
-- satisfy RLS's `auth.uid() = user_id` check while inserting a row whose
-- client_id pointed at another tenant's client, and PostgreSQL accepted
-- it (reproduced through a genuine authenticated staging REST session:
-- the cross-tenant insert returned HTTP 201). Reads stayed isolated, but
-- the write did not.
--
-- 20260726000000_canonical_clients.sql now creates the table with the
-- composite tenant-safe FK from the start, but Supabase does not re-run
-- an already-applied migration file just because its contents changed —
-- an environment that already ran that migration before this fix existed
-- (current hosted staging) would never receive the corrected FK from
-- editing that file alone. This migration replaces the single-column FK
-- with the same composite tenant-ownership pattern already proven by
-- invoices_user_id_client_id_fkey, and does so idempotently so it is also
-- safe to run against a fresh database where the corrected historical
-- migration already created the desired constraint under the same name.
--
-- Does not weaken RLS: client_source_identities_insert_own/_update_own
-- remain exactly as they are. The composite FK is a second, independent,
-- structural guarantee that holds for every role (including service_role
-- and any other role that bypasses RLS), not a replacement for RLS.

do $preflight$
begin
  if exists (
    select 1
    from public.client_source_identities si
    join public.clients c on c.id = si.client_id
    where si.user_id <> c.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot enforce client_source_identities tenant ownership: cross-tenant relationships exist';
  end if;
end
$preflight$;

-- Idempotent and, on a fresh install, already created by the corrected
-- 20260726000000_canonical_clients.sql — see that file for why it is
-- created there too, ahead of 20260803021842_enforce_invoice_client_
-- tenant_ownership.sql where it was originally introduced for invoices.
create unique index if not exists clients_user_id_id_uidx
  on public.clients(user_id, id);

-- Named to match what the corrected 20260726000000_canonical_clients.sql
-- creates inline on a fresh install, so this step is a genuine no-op there
-- instead of racing a second, differently-named constraint into existence.
do $constraint$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_user_id_client_id_fkey'
      and contype = 'f'
  ) then
    alter table public.client_source_identities
      add constraint client_source_identities_user_id_client_id_fkey
      foreign key (user_id, client_id)
      references public.clients(user_id, id)
      on update no action
      on delete cascade
      not valid;
  end if;
end
$constraint$;

-- Safe to re-run: validating an already-valid constraint is a no-op.
alter table public.client_source_identities
  validate constraint client_source_identities_user_id_client_id_fkey;

-- Remove only the repository's superseded FK shape, regardless of its
-- name. On an already-migrated environment this drops the original
-- single-column client_id -> clients(id) FK. On a fresh install (where
-- the corrected historical migration never created that shape) this loop
-- matches nothing and is a no-op.
do $drop_single_column_fks$
declare
  v_constraint record;
  v_client_id_attnum smallint;
  v_client_pk_attnum smallint;
begin
  select attnum into v_client_id_attnum
  from pg_attribute
  where attrelid = 'public.client_source_identities'::regclass and attname = 'client_id';

  select attnum into v_client_pk_attnum
  from pg_attribute
  where attrelid = 'public.clients'::regclass and attname = 'id';

  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and confrelid = 'public.clients'::regclass
      and contype = 'f'
      and conkey = array[v_client_id_attnum]::smallint[]
      and confkey = array[v_client_pk_attnum]::smallint[]
  loop
    execute format(
      'alter table public.client_source_identities drop constraint %I',
      v_constraint.conname
    );
  end loop;
end
$drop_single_column_fks$;

-- Refresh the Phase 0 unknown-FK gate: client_source_identities now
-- contributes two column-pair rows (user_id -> clients.user_id and
-- client_id -> clients.id) for its one composite FK, replacing the single
-- client_id -> clients.id row the old single-column FK produced.
create or replace function duewatch_ops.unknown_client_foreign_keys()
returns table(
  table_schema text,
  table_name text,
  column_name text,
  foreign_table_schema text,
  foreign_table_name text,
  foreign_column_name text,
  delete_rule text,
  update_rule text
) language sql security definer set search_path = pg_catalog, public as $$
  with relationships as (
    select
      child_ns.nspname::text as table_schema,
      child.relname::text as table_name,
      child_col.attname::text as column_name,
      parent_ns.nspname::text as foreign_table_schema,
      parent.relname::text as foreign_table_name,
      parent_col.attname::text as foreign_column_name,
      case fk.confdeltype
        when 'a' then 'NO ACTION'
        when 'r' then 'RESTRICT'
        when 'c' then 'CASCADE'
        when 'n' then 'SET NULL'
        when 'd' then 'SET DEFAULT'
      end::text as delete_rule,
      case fk.confupdtype
        when 'a' then 'NO ACTION'
        when 'r' then 'RESTRICT'
        when 'c' then 'CASCADE'
        when 'n' then 'SET NULL'
        when 'd' then 'SET DEFAULT'
      end::text as update_rule
    from pg_constraint fk
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_class parent on parent.oid = fk.confrelid
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    join lateral unnest(fk.conkey) with ordinality child_key(attnum, ord) on true
    join lateral unnest(fk.confkey) with ordinality parent_key(attnum, ord)
      on parent_key.ord = child_key.ord
    join pg_attribute child_col
      on child_col.attrelid = child.oid and child_col.attnum = child_key.attnum
    join pg_attribute parent_col
      on parent_col.attrelid = parent.oid and parent_col.attnum = parent_key.attnum
    where fk.contype = 'f'
      -- Phase 0 mutates client rows and invoice.client_id. Only foreign keys
      -- whose referenced table is clients/invoices can be affected by those
      -- operations; the separate auth.users ownership FKs are out of scope.
      and parent_ns.nspname = 'public'
      and parent.relname in ('clients', 'invoices')
  )
  select r.* from relationships r
  where (r.table_schema, r.table_name, r.column_name,
         r.foreign_table_schema, r.foreign_table_name, r.foreign_column_name,
         r.delete_rule, r.update_rule)
    not in (
      ('public','invoices','user_id','public','clients','user_id','SET NULL','NO ACTION'),
      ('public','invoices','client_id','public','clients','id','SET NULL','NO ACTION'),
      ('public','client_source_identities','user_id','public','clients','user_id','CASCADE','NO ACTION'),
      ('public','client_source_identities','client_id','public','clients','id','CASCADE','NO ACTION'),
      ('public','line_items','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
      ('public','reminders','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
      ('public','events','invoice_id','public','invoices','id','SET NULL','NO ACTION'),
      ('public','awaiting_signature','invoice_id','public','invoices','id','CASCADE','NO ACTION')
    )
$$;
revoke execute on function duewatch_ops.unknown_client_foreign_keys()
  from public, anon, authenticated;
grant execute on function duewatch_ops.unknown_client_foreign_keys()
  to service_role;

do $postconditions$
declare
  v_definition text;
begin
  select pg_get_constraintdef(oid) into v_definition
  from pg_constraint
  where conrelid = 'public.client_source_identities'::regclass
    and conname = 'client_source_identities_user_id_client_id_fkey'
    and contype = 'f';

  if v_definition is null
    or v_definition not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_definition not like '%ON DELETE CASCADE%' then
    raise exception 'client_source_identities tenant constraint does not match the required definition';
  end if;

  if exists(select 1 from duewatch_ops.unknown_client_foreign_keys()) then
    raise exception 'client_source_identities tenant migration left an unknown client/invoice FK';
  end if;

  if (select execution_enabled
      from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution must remain disabled';
  end if;
end
$postconditions$;
