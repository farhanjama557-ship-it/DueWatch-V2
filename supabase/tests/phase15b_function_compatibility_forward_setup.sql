-- TEST ONLY: emulate the exact process_import_batch definition already
-- installed on hosted staging before the append-only compatibility migration.
-- The caller has applied the corrected fresh-install migration, so this file
-- changes only its WHERE-qualified temp-table reset back to the one known
-- hosted-incompatible statement. The surrounding verification transaction
-- always rolls this emulation back.
-- Never run this file against hosted staging or production.

do $forward_setup$
declare
  v_definition text;
  v_safe_reset constant text := 'delete from _claimed_rows' || chr(10) || '  where id is not null;';
  v_unsafe_reset constant text := 'delete from _claimed_rows;';
begin
  select pg_get_functiondef('public.process_import_batch(uuid, integer)'::regprocedure)
  into v_definition;

  if position(v_unsafe_reset in lower(v_definition)) > 0 then
    raise exception 'Forward setup expected the corrected definition, but the unsafe reset already exists';
  end if;
  if position(v_safe_reset in lower(v_definition)) = 0 then
    raise exception 'Forward setup could not find the exact corrected reset to emulate hosted State A';
  end if;

  v_definition := replace(v_definition, v_safe_reset, v_unsafe_reset);
  execute v_definition;

  select pg_get_functiondef('public.process_import_batch(uuid, integer)'::regprocedure)
  into v_definition;
  if position(v_unsafe_reset in lower(v_definition)) = 0
     or position(v_safe_reset in lower(v_definition)) > 0 then
    raise exception 'Failed to emulate the exact hosted-incompatible function state';
  end if;
end
$forward_setup$;

\echo 'FORWARD STATE PASS: original hosted process_import_batch reset emulated'
