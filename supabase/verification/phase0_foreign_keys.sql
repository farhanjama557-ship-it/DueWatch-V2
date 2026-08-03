-- Run in STAGING after applying schema.sql and the Phase 0 migration.
-- This is read-only. It raises on any unknown or missing FK touching
-- public.clients/public.invoices and emits the JSON required for attestation.

begin transaction read only;

-- Full auditable catalog snapshot. pg_constraint + ordinality pairs each
-- child column with the correct parent column for composite foreign keys.
select
  fk.conname as constraint_name,
  child_ns.nspname as table_schema,
  child.relname as table_name,
  child_col.attname as column_name,
  parent_ns.nspname as foreign_table_schema,
  parent.relname as foreign_table_name,
  parent_col.attname as foreign_column_name,
  pg_get_constraintdef(fk.oid) as constraint_definition
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
  and (
    (parent_ns.nspname = 'public' and parent.relname in ('clients', 'invoices'))
    or (child_ns.nspname = 'public' and child.relname in ('clients', 'invoices'))
  )
order by child_ns.nspname, child.relname, fk.conname, child_key.ord;

do $verify$
declare
  v_unknown jsonb;
  v_missing jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
  into v_unknown from duewatch_ops.unknown_client_foreign_keys() f;

  with expected(
    table_schema, table_name, column_name,
    foreign_table_schema, foreign_table_name, foreign_column_name,
    delete_rule, update_rule
  ) as (values
    ('public','invoices','user_id','public','clients','user_id','SET NULL','NO ACTION'),
    ('public','invoices','client_id','public','clients','id','SET NULL','NO ACTION'),
    ('public','client_source_identities','client_id','public','clients','id','CASCADE','NO ACTION'),
    ('public','line_items','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
    ('public','reminders','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
    ('public','events','invoice_id','public','invoices','id','SET NULL','NO ACTION'),
    ('public','awaiting_signature','invoice_id','public','invoices','id','CASCADE','NO ACTION')
  ), actual as (
    select
      child_ns.nspname::text as table_schema,
      child.relname::text as table_name,
      child_col.attname::text as column_name,
      parent_ns.nspname::text as foreign_table_schema,
      parent.relname::text as foreign_table_name,
      parent_col.attname::text as foreign_column_name,
      case fk.confdeltype
        when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
        when 'c' then 'CASCADE' when 'n' then 'SET NULL'
        when 'd' then 'SET DEFAULT'
      end::text as delete_rule,
      case fk.confupdtype
        when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
        when 'c' then 'CASCADE' when 'n' then 'SET NULL'
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
  )
  select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb)
  into v_missing from expected e
  where not exists(
    select 1 from actual a
    where (a.table_schema, a.table_name, a.column_name,
      a.foreign_table_schema, a.foreign_table_name, a.foreign_column_name,
      a.delete_rule, a.update_rule)
    = (e.table_schema, e.table_name, e.column_name,
      e.foreign_table_schema, e.foreign_table_name, e.foreign_column_name,
      e.delete_rule, e.update_rule)
  );

  if jsonb_array_length(v_unknown) > 0 then
    raise exception 'Unknown client/invoice foreign keys: %', v_unknown;
  end if;
  if jsonb_array_length(v_missing) > 0 then
    raise exception 'Expected client/invoice foreign keys are missing: %', v_missing;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_user_id_client_id_fkey'
      and contype = 'f'
      and convalidated
      and pg_get_constraintdef(oid)
        like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%ON DELETE SET NULL (client_id)%'
  ) then
    raise exception 'Validated composite invoice/client tenant constraint is missing or has unsafe delete behavior';
  end if;
end
$verify$;

select jsonb_build_object(
  'environment', 'staging',
  'verified_at', now(),
  'unknown_foreign_keys', '[]'::jsonb,
  'missing_foreign_keys', '[]'::jsonb,
  'verification_sql', 'supabase/verification/phase0_foreign_keys.sql'
) as passing_attestation_evidence;

rollback;
