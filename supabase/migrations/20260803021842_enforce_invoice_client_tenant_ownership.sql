-- Enforce tenant ownership for every invoice/client relationship.
--
-- The existing single-column FK proves only that client_id exists. This
-- composite FK also proves that the invoice and client belong to the same
-- user. It applies to every database role, including roles that bypass RLS.

do $preflight$
begin
  if exists (
    select 1
    from public.invoices i
    join public.clients c on c.id = i.client_id
    where i.client_id is not null
      and i.user_id <> c.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot enforce invoice/client tenant ownership: cross-tenant relationships exist';
  end if;
end
$preflight$;

-- PostgreSQL requires the referenced composite columns to be covered by a
-- non-partial unique index. clients.id remains the primary key, so this adds
-- no new identity semantics; it makes (user_id, id) a valid FK target.
create unique index if not exists clients_user_id_id_uidx
  on public.clients(user_id, id);

do $constraint$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_user_id_client_id_fkey'
      and contype = 'f'
  ) then
    alter table public.invoices
      add constraint invoices_user_id_client_id_fkey
      foreign key (user_id, client_id)
      references public.clients(user_id, id)
      on update no action
      on delete set null (client_id)
      not valid;
  end if;
end
$constraint$;

alter table public.invoices
  validate constraint invoices_user_id_client_id_fkey;

-- Remove only the repository's superseded FK shape, regardless of its name.
-- The new composite constraint stays in place throughout this step.
do $drop_single_column_fks$
declare
  v_constraint record;
  v_client_id_attnum smallint;
  v_client_pk_attnum smallint;
begin
  select attnum into v_client_id_attnum
  from pg_attribute
  where attrelid = 'public.invoices'::regclass and attname = 'client_id';

  select attnum into v_client_pk_attnum
  from pg_attribute
  where attrelid = 'public.clients'::regclass and attname = 'id';

  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and confrelid = 'public.clients'::regclass
      and contype = 'f'
      and conkey = array[v_client_id_attnum]::smallint[]
      and confkey = array[v_client_pk_attnum]::smallint[]
  loop
    execute format(
      'alter table public.invoices drop constraint %I',
      v_constraint.conname
    );
  end loop;
end
$drop_single_column_fks$;

-- Refresh the Phase 0 unknown-FK gate so it pairs composite FK columns by
-- ordinal position instead of producing a Cartesian product through
-- information_schema.constraint_column_usage.
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
      -- client_source_identities' single-column client_id FK below was
      -- superseded by a composite (user_id, client_id) tenant-safe FK, the
      -- same pattern as invoices above (see
      -- 20260811000000_client_source_identities_tenant_fk.sql). Kept
      -- current here too, not just in that later migration: on a fresh
      -- install 20260726000000_canonical_clients.sql now creates
      -- client_source_identities with the composite FK from the start, so
      -- by the time this migration's own postcondition check below runs
      -- (immediately after this function is (re)defined), the table
      -- already has the composite shape and needs it in the allowlist -
      -- an already-migrated environment still gets this update for real
      -- via the later forward migration re-defining this same function,
      -- since Supabase does not re-run an already-applied migration file.
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
  where conrelid = 'public.invoices'::regclass
    and conname = 'invoices_user_id_client_id_fkey'
    and contype = 'f';

  if v_definition is null
    or v_definition not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_definition not like '%ON DELETE SET NULL (client_id)%' then
    raise exception 'Invoice/client tenant constraint does not match the required definition';
  end if;

  if exists(select 1 from duewatch_ops.unknown_client_foreign_keys()) then
    raise exception 'Invoice/client tenant migration left an unknown client/invoice FK';
  end if;

  if (select execution_enabled
      from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution must remain disabled';
  end if;
end
$postconditions$;
