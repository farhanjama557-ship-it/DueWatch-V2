-- Disposable database proof for the DW Night Shift control plane.
begin;

\echo 'TEST GROUP START: night_shift_cross_tenant_references_fail_closed'
do $tenant$
declare
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  c2 uuid := gen_random_uuid();
  run1 uuid := gen_random_uuid();
  failed_as_expected boolean := false;
begin
  insert into auth.users(id, email) values
    (u1, 'nightshift-u1@example.test'),
    (u2, 'nightshift-u2@example.test');

  insert into public.clients(id, user_id, name)
  values (c2, u2, 'Foreign client');

  begin
    insert into public.autopilot_protected_clients(user_id, client_id)
    values (u1, c2);
  exception when foreign_key_violation then
    failed_as_expected := true;
  end;
  if not failed_as_expected then
    raise exception 'cross-tenant protected client reference was accepted';
  end if;

  insert into public.autopilot_shift_runs(id, user_id, mode)
  values (run1, u1, 'NIGHT_SHIFT');

  failed_as_expected := false;
  begin
    insert into public.autopilot_shift_log(
      user_id, shift_run_id, disposition, result
    ) values (
      u2, run1, 'BLOCKED', '{"status":"WITHHELD"}'::jsonb
    );
  exception when foreign_key_violation then
    failed_as_expected := true;
  end;
  if not failed_as_expected then
    raise exception 'cross-tenant shift log/run reference was accepted';
  end if;
end
$tenant$;
\echo 'TEST GROUP PASS: night_shift_cross_tenant_references_fail_closed'

\echo 'TEST GROUP START: night_shift_temporary_strategy_is_bounded'
do $strategy$
declare
  u uuid := gen_random_uuid();
  rejected boolean := false;
begin
  insert into auth.users(id, email) values (u, 'nightshift-strategy@example.test');

  begin
    insert into public.autopilot_temporary_strategies(
      user_id, approved_at, approved_by, starts_at, expires_at, overrides
    ) values (
      u, now(), u, now(), now() - interval '1 minute', '{"priority_bias":"cash"}'::jsonb
    );
  exception when check_violation then
    rejected := true;
  end;
  if not rejected then
    raise exception 'strategy with non-forward expiry was accepted';
  end if;

  insert into public.autopilot_temporary_strategies(
    user_id, approved_at, approved_by, starts_at, expires_at, overrides
  ) values (
    u, now(), u, now(), now() + interval '2 hours',
    '{"priority_bias":"collectible_cash","forecast_weight_cap":0.5}'::jsonb
  );
end
$strategy$;
\echo 'TEST GROUP PASS: night_shift_temporary_strategy_is_bounded'

\echo 'TEST GROUP START: night_shift_rls_enabled'
do $rls$
declare
  missing_count integer;
begin
  select count(*) into missing_count
  from (
    values
      ('autopilot_mode_configs'),
      ('autopilot_authority_policies'),
      ('autopilot_protected_clients'),
      ('autopilot_temporary_strategies'),
      ('autopilot_shift_runs'),
      ('autopilot_shift_log'),
      ('autopilot_morning_handoffs')
  ) as expected(relname)
  left join pg_class c on c.relname = expected.relname
  left join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.oid is null or c.relrowsecurity is distinct from true;

  if missing_count <> 0 then
    raise exception 'expected every Night Shift table to have RLS enabled; missing=%', missing_count;
  end if;
end
$rls$;
\echo 'TEST GROUP PASS: night_shift_rls_enabled'

\echo 'TEST GROUP START: night_shift_default_authority_is_empty'
do $defaults$
declare
  u uuid := gen_random_uuid();
  actions text[];
  channels text[];
  enabled boolean;
begin
  insert into auth.users(id, email) values (u, 'nightshift-defaults@example.test');
  insert into public.autopilot_authority_policies(user_id) values (u)
  returning allowed_actions, allowed_channels, autopilot_authority_policies.enabled
  into actions, channels, enabled;

  if enabled is distinct from false then
    raise exception 'authority policy must default disabled';
  end if;
  if cardinality(actions) <> 0 or cardinality(channels) <> 0 then
    raise exception 'authority lists must default empty';
  end if;
end
$defaults$;
\echo 'TEST GROUP PASS: night_shift_default_authority_is_empty'

rollback;
