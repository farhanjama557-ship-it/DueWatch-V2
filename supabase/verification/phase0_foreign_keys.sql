-- Run in STAGING after applying schema.sql and the Phase 0 migration.
-- This is read-only. It raises on any unknown or missing FK touching
-- public.clients/public.invoices and emits the JSON required for attestation.

begin transaction read only;

-- Full auditable catalog snapshot.
select
  tc.table_schema,
  tc.table_name,
  kcu.column_name,
  ccu.table_schema as foreign_table_schema,
  ccu.table_name as foreign_table_name,
  ccu.column_name as foreign_column_name,
  rc.delete_rule,
  rc.update_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name
 and kcu.constraint_schema = tc.constraint_schema
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name
 and ccu.constraint_schema = tc.constraint_schema
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
 and rc.constraint_schema = tc.constraint_schema
where tc.constraint_type = 'FOREIGN KEY'
  and (
    (ccu.table_schema = 'public' and ccu.table_name in ('clients', 'invoices'))
    or (tc.table_schema = 'public' and tc.table_name in ('clients', 'invoices'))
  )
order by tc.table_schema, tc.table_name, kcu.column_name;

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
    ('public','invoices','client_id','public','clients','id','SET NULL','NO ACTION'),
    ('public','client_source_identities','client_id','public','clients','id','CASCADE','NO ACTION'),
    ('public','line_items','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
    ('public','reminders','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
    ('public','events','invoice_id','public','invoices','id','SET NULL','NO ACTION'),
    ('public','awaiting_signature','invoice_id','public','invoices','id','CASCADE','NO ACTION')
  ), actual as (
    select
      tc.table_schema::text,
      tc.table_name::text,
      kcu.column_name::text,
      ccu.table_schema::text foreign_table_schema,
      ccu.table_name::text foreign_table_name,
      ccu.column_name::text foreign_column_name,
      rc.delete_rule::text,
      rc.update_rule::text
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.constraint_schema = tc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.constraint_schema = tc.constraint_schema
    join information_schema.referential_constraints rc
      on rc.constraint_name = tc.constraint_name
     and rc.constraint_schema = tc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY'
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
