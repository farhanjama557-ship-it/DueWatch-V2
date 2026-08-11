-- Read-only catalog regression for the hosted require-WHERE incompatibility.
-- This inspects the final deployed function definitions, not merely migration
-- text. Functional repeated-call behavior is covered separately by
-- repeated_call_temp_table_reset in import_persistence_recovery_test.sql.

\echo 'TEST GROUP START: hosted_require_where_compatibility'
do $hosted_compatibility$
declare
  v_proc regprocedure;
  v_definition text;
  v_code text;
  v_statement text;
  v_process_definition text;
  v_phase15b_functions constant regprocedure[] := array[
    'duewatch_ops.evaluate_row_eligibility(text, text[], jsonb, boolean)'::regprocedure,
    'duewatch_ops.resolve_client_for_import(uuid, text, text, text, text, text, text, jsonb)'::regprocedure,
    'public.start_import_run(uuid, text, jsonb, boolean)'::regprocedure,
    'public.process_import_batch(uuid, integer)'::regprocedure,
    'public.request_import_cancellation(uuid)'::regprocedure
  ];
begin
  foreach v_proc in array v_phase15b_functions loop
    select pg_get_functiondef(v_proc) into v_definition;
    -- Remove line comments before scanning statement fragments so prose in a
    -- comment can never satisfy or trip the production-DML contract.
    v_code := regexp_replace(v_definition, '--[^' || chr(10) || chr(13) || ']*', '', 'g');

    for v_statement in
      select fragment
      from regexp_split_to_table(v_code, ';') fragment
      where fragment ~* ('(^|' || chr(10) || ')[[:space:]]*'
        || '(delete[[:space:]]+from|update[[:space:]]+)')
    loop
      if v_statement !~* '\mwhere\M' then
        raise exception 'Hosted-incompatible WHERE-less DML in %: %',
          v_proc, left(regexp_replace(trim(v_statement), '[[:space:]]+', ' ', 'g'), 240);
      end if;
    end loop;
  end loop;

  select pg_get_functiondef('public.process_import_batch(uuid, integer)'::regprocedure)
  into v_process_definition;
  if v_process_definition ~* 'delete[[:space:]]+from[[:space:]]+_claimed_rows[[:space:]]*;' then
    raise exception 'Exact unsafe DELETE FROM _claimed_rows statement remains';
  end if;
  if v_process_definition !~* ('delete[[:space:]]+from[[:space:]]+_claimed_rows'
      || '[[:space:]]+where[[:space:]]+id[[:space:]]+is[[:space:]]+not[[:space:]]+null[[:space:]]*;') then
    raise exception 'The _claimed_rows reset lacks the required explicit WHERE predicate';
  end if;

  if not (select prosecdef from pg_proc
          where oid = 'public.process_import_batch(uuid, integer)'::regprocedure) then
    raise exception 'process_import_batch is no longer SECURITY DEFINER';
  end if;
  if (select proconfig from pg_proc
      where oid = 'public.process_import_batch(uuid, integer)'::regprocedure)
      is distinct from array['search_path=public, duewatch_ops, pg_temp']::text[] then
    raise exception 'process_import_batch search_path changed';
  end if;
  if not has_function_privilege('authenticated', 'public.process_import_batch(uuid, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.process_import_batch(uuid, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.process_import_batch(uuid, integer)', 'EXECUTE')
     or exists (
       select 1
       from pg_proc p,
            lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where p.oid = 'public.process_import_batch(uuid, integer)'::regprocedure
         and acl.grantee = 0
         and acl.privilege_type = 'EXECUTE'
     ) then
    raise exception 'process_import_batch EXECUTE contract changed';
  end if;

  -- Security/behavior anchors: these are deliberately exact enough to catch
  -- accidental contract drift in the forward function copy while the full
  -- fresh/forward schema fingerprint proves byte-level catalog convergence.
  if position('auth.uid()) <> v_run.user_id' in v_process_definition) = 0
     or position('p_batch_size < 1 or p_batch_size > 200' in v_process_definition) = 0
     or position('where id = p_run_id for update' in v_process_definition) = 0
     or position('if v_run.cancel_requested_at is not null' in v_process_definition) = 0
     or position('order by row_number' in v_process_definition) = 0
     or position('for update skip locked' in v_process_definition) = 0
     or position('exception when others then' in v_process_definition) = 0
     or position('v_sanitized_reason' in v_process_definition) = 0
     or position('AMBIGUOUS_INVOICE_IDENTITY' in v_process_definition) = 0
     or position('INVOICE_MATERIAL_CONFLICT' in v_process_definition) = 0 then
    raise exception 'process_import_batch behavior/security anchors changed';
  end if;
end
$hosted_compatibility$;
\echo 'TEST GROUP PASS: hosted_require_where_compatibility'
