-- Phase 0: canonical client identity and reversible duplicate cleanup.
-- Applying this migration is non-destructive. Execution is disabled by
-- default and requires three independent gates plus a run-specific phrase.

create schema if not exists duewatch_ops;
revoke all on schema duewatch_ops from public, anon, authenticated;
grant usage on schema duewatch_ops to service_role;

create table if not exists duewatch_ops.client_dedup_config (
  singleton boolean primary key default true check (singleton),
  execution_enabled boolean not null default false,
  changed_at timestamptz not null default now(),
  change_note text not null default 'Execution disabled by migration'
);
insert into duewatch_ops.client_dedup_config(singleton)
values (true) on conflict (singleton) do nothing;
revoke all on duewatch_ops.client_dedup_config from public, anon, authenticated;

create or replace function public.normalize_client_text(value text)
returns text language sql immutable parallel safe as $$
  select nullif(trim(regexp_replace(
    lower(coalesce(value, '')), '[^[:alnum:]]+', ' ', 'g'
  )), '')
$$;

create or replace function public.normalize_client_email(value text)
returns text language sql immutable parallel safe as $$
  select nullif(lower(trim(coalesce(value, ''))), '')
$$;

create or replace function public.normalize_client_phone(value text)
returns text language sql immutable parallel safe as $$
  select nullif(regexp_replace(coalesce(value, ''), '[^0-9]+', '', 'g'), '')
$$;

revoke execute on function public.normalize_client_text(text) from public, anon;
revoke execute on function public.normalize_client_email(text) from public, anon;
revoke execute on function public.normalize_client_phone(text) from public, anon;
grant execute on function public.normalize_client_text(text) to authenticated, service_role;
grant execute on function public.normalize_client_email(text) to authenticated, service_role;
grant execute on function public.normalize_client_phone(text) to authenticated, service_role;

alter table public.clients add column if not exists canonical_id uuid;
alter table public.clients add column if not exists normalized_name text;
alter table public.clients add column if not exists normalized_email text;
alter table public.clients add column if not exists normalized_domain text;
alter table public.clients add column if not exists normalized_phone text;
alter table public.clients add column if not exists normalized_company text;

update public.clients
set canonical_id = coalesce(canonical_id, id),
    normalized_name = public.normalize_client_text(name),
    normalized_email = public.normalize_client_email(email),
    normalized_domain = nullif(split_part(
      public.normalize_client_email(email), '@', 2
    ), ''),
    normalized_phone = public.normalize_client_phone(phone),
    normalized_company = public.normalize_client_text(company);

alter table public.clients alter column canonical_id set default gen_random_uuid();
alter table public.clients alter column canonical_id set not null;
create unique index if not exists clients_canonical_id_uidx
  on public.clients(canonical_id);
create index if not exists clients_normalized_name_idx
  on public.clients(user_id, normalized_name);
create index if not exists clients_normalized_email_idx
  on public.clients(user_id, normalized_email);
create index if not exists clients_normalized_phone_idx
  on public.clients(user_id, normalized_phone);

create or replace function public.set_client_identity_fields()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.canonical_id := coalesce(new.canonical_id, gen_random_uuid());
  new.normalized_name := public.normalize_client_text(new.name);
  new.normalized_email := public.normalize_client_email(new.email);
  new.normalized_domain := nullif(split_part(new.normalized_email, '@', 2), '');
  new.normalized_phone := public.normalize_client_phone(new.phone);
  new.normalized_company := public.normalize_client_text(new.company);
  return new;
end
$$;
revoke execute on function public.set_client_identity_fields() from public, anon, authenticated;

drop trigger if exists clients_set_identity_fields on public.clients;
create trigger clients_set_identity_fields
  before insert or update of name, email, phone, company, canonical_id
  on public.clients for each row execute function public.set_client_identity_fields();

-- PostgreSQL requires the referenced composite columns to be covered by a
-- non-partial unique index. clients.id remains the primary key, so this adds
-- no new identity semantics; it makes (user_id, id) a valid FK target. Also
-- (re)created, idempotently, by 20260803021842_enforce_invoice_client_tenant_
-- ownership.sql for the invoices FK — creating it here too, ahead of that
-- migration, is what lets client_source_identities be born with the same
-- tenant-safe FK shape on a fresh install instead of only gaining it later.
create unique index if not exists clients_user_id_id_uidx
  on public.clients(user_id, id);

-- A single-column client_id FK only proves the referenced client exists —
-- not that it belongs to the same tenant as user_id. An authenticated
-- caller could satisfy RLS's `auth.uid() = user_id` check while pointing
-- client_id at a different tenant's client, and PostgreSQL would accept it.
-- The composite FK below is the same tenant-ownership pattern already used
-- by invoices_user_id_client_id_fkey: it proves both that the client exists
-- and that it belongs to user_id, enforced for every role (including ones
-- that bypass RLS), not just the authenticated insert/update paths.
create table if not exists public.client_source_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  source text not null,
  external_id text not null,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, source, external_id),
  constraint client_source_identities_user_id_client_id_fkey
    foreign key (user_id, client_id)
    references public.clients(user_id, id)
    on update no action
    on delete cascade
);
create index if not exists client_source_identities_client_idx
  on public.client_source_identities(client_id);
alter table public.client_source_identities enable row level security;
drop policy if exists "client_source_identities_select_own"
  on public.client_source_identities;
create policy "client_source_identities_select_own"
  on public.client_source_identities for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- resolve_or_create_client() runs security invoker, so an authenticated
-- caller's own insert/upsert into this table is subject to RLS directly.
-- Table privileges already permit insert/update, but with RLS enabled and
-- only a select-own policy present, RLS denied every insert by default —
-- the hosted-staging failure on the source-identity path. These two
-- policies scope insert/update to the caller's own rows, matching the
-- select-own policy and the table's tenant-scoped
-- unique(user_id, source, external_id) constraint.
drop policy if exists "client_source_identities_insert_own"
  on public.client_source_identities;
create policy "client_source_identities_insert_own"
  on public.client_source_identities
  for insert
  to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "client_source_identities_update_own"
  on public.client_source_identities;
create policy "client_source_identities_update_own"
  on public.client_source_identities
  for update
  to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

grant select on public.client_source_identities to authenticated;
grant select, insert, update, delete on public.client_source_identities to service_role;

insert into public.client_source_identities(
  user_id, client_id, source, external_id, provenance
)
select user_id, id, 'duewatch', id::text,
  jsonb_build_object(
    'kind', 'legacy_client_id',
    'backfilled_at', now(),
    'canonical_id', canonical_id
  )
from public.clients
on conflict(user_id, source, external_id) do update
set client_id = excluded.client_id,
    provenance = public.client_source_identities.provenance || excluded.provenance;

create table if not exists public.client_dedup_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'prepared' check (
    status in ('prepared', 'executing', 'completed', 'rolled_back', 'failed')
  ),
  summary jsonb not null default '{}'::jsonb,
  foreign_keys_verified_at timestamptz,
  foreign_key_evidence jsonb,
  integration_tests_passed_at timestamptz,
  integration_test_evidence jsonb,
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  rolled_back_at timestamptz
);

create table if not exists public.client_merge_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.client_dedup_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Deliberately not foreign keys: audit/candidate IDs must survive deletion.
  primary_client_id uuid not null,
  duplicate_client_id uuid not null,
  classification text not null check (
    classification in ('exact', 'review_required')
  ),
  rule_code text not null,
  status text not null check (
    status in ('ready', 'review_required', 'approved', 'skipped', 'executed')
  ),
  evidence jsonb not null default '{}'::jsonb,
  affected_invoice_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique(run_id, primary_client_id, duplicate_client_id)
);

create table if not exists public.client_merge_audit (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.client_dedup_runs(id) on delete restrict,
  candidate_id uuid not null references public.client_merge_candidates(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary_client_id uuid not null,
  duplicate_client_id uuid not null,
  duplicate_snapshot jsonb not null,
  relationship_snapshot jsonb not null,
  executed_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  unique(run_id, duplicate_client_id)
);

create index if not exists client_dedup_runs_user_created_idx
  on public.client_dedup_runs(user_id, created_at desc);
create index if not exists client_merge_candidates_user_idx
  on public.client_merge_candidates(user_id);
create index if not exists client_merge_audit_user_idx
  on public.client_merge_audit(user_id);
create index if not exists client_merge_audit_candidate_idx
  on public.client_merge_audit(candidate_id);

alter table public.client_dedup_runs enable row level security;
alter table public.client_merge_candidates enable row level security;
alter table public.client_merge_audit enable row level security;

drop policy if exists "client_dedup_runs_select_own" on public.client_dedup_runs;
create policy "client_dedup_runs_select_own"
  on public.client_dedup_runs for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
drop policy if exists "client_merge_candidates_select_own"
  on public.client_merge_candidates;
create policy "client_merge_candidates_select_own"
  on public.client_merge_candidates for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
drop policy if exists "client_merge_audit_select_own" on public.client_merge_audit;
create policy "client_merge_audit_select_own"
  on public.client_merge_audit for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

grant select on public.client_dedup_runs,
  public.client_merge_candidates, public.client_merge_audit to authenticated;
grant select, insert, update, delete on public.client_dedup_runs,
  public.client_merge_candidates, public.client_merge_audit to service_role;

-- Returns any FK touching clients/invoices that is not in the verified map.
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
      and (
        (ccu.table_schema = 'public'
          and ccu.table_name in ('clients', 'invoices'))
        or (tc.table_schema = 'public'
          and tc.table_name in ('clients', 'invoices'))
      )
  )
  select r.* from relationships r
  where (r.table_schema, r.table_name, r.column_name,
         r.foreign_table_schema, r.foreign_table_name, r.foreign_column_name,
         r.delete_rule, r.update_rule)
    not in (
      ('public','invoices','client_id','public','clients','id','SET NULL','NO ACTION'),
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

create or replace function duewatch_ops.prepare_client_dedup(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run_id uuid := gen_random_uuid();
begin
  insert into public.client_dedup_runs(id, user_id) values(v_run_id, p_user_id);

  with pairs as (
    select
      older.id primary_id,
      older.created_at primary_created_at,
      newer.id duplicate_id,
      case
        when older.normalized_email is not null
         and older.normalized_email = newer.normalized_email
         and (
           (older.normalized_name is not null
             and older.normalized_name = newer.normalized_name)
           or (older.normalized_company is not null
             and older.normalized_company = newer.normalized_company)
         ) then 'email_with_name_or_company'
        when older.normalized_phone is not null
         and older.normalized_phone = newer.normalized_phone
         and (
           (older.normalized_name is not null
             and older.normalized_name = newer.normalized_name)
           or (older.normalized_company is not null
             and older.normalized_company = newer.normalized_company)
         ) then 'phone_with_name_or_company'
        when older.normalized_domain is not null
         and older.normalized_domain = newer.normalized_domain
         and older.normalized_company is not null
         and older.normalized_company = newer.normalized_company
          then 'domain_with_company'
        when older.normalized_email is not null
         and older.normalized_email = newer.normalized_email then 'email_only'
        when older.normalized_name is not null
         and older.normalized_name = newer.normalized_name then 'name_only'
        when older.normalized_phone is not null
         and older.normalized_phone = newer.normalized_phone then 'phone_only'
        when older.normalized_domain is not null
         and older.normalized_domain = newer.normalized_domain then 'domain_only'
      end rule_code
    from public.clients older
    join public.clients newer
      on newer.user_id = older.user_id
     and (older.created_at, older.id) < (newer.created_at, newer.id)
    where older.user_id = p_user_id
      and (
        (older.normalized_email is not null
          and older.normalized_email = newer.normalized_email)
        or (older.normalized_phone is not null
          and older.normalized_phone = newer.normalized_phone)
        or (older.normalized_name is not null
          and older.normalized_name = newer.normalized_name)
        or (older.normalized_domain is not null
          and older.normalized_domain = newer.normalized_domain)
      )
  ), ranked as (
    select *, row_number() over (
      partition by duplicate_id
      order by
        case rule_code
          when 'email_with_name_or_company' then 1
          when 'phone_with_name_or_company' then 10
          when 'domain_with_company' then 11
          when 'email_only' then 12
          when 'name_only' then 13
          when 'phone_only' then 14
          else 15
        end,
        primary_created_at,
        primary_id
    ) candidate_rank
    from pairs where rule_code is not null
  )
  insert into public.client_merge_candidates(
    run_id, user_id, primary_client_id, duplicate_client_id,
    classification, rule_code, status, evidence, affected_invoice_count
  )
  select
    v_run_id, p_user_id, r.primary_id, r.duplicate_id,
    case when r.rule_code = 'email_with_name_or_company'
      then 'exact' else 'review_required' end,
    r.rule_code,
    case when r.rule_code = 'email_with_name_or_company'
      then 'ready' else 'review_required' end,
    jsonb_build_object(
      'normalized', jsonb_build_object(
        'primary_name', a.normalized_name,
        'duplicate_name', b.normalized_name,
        'primary_email', a.normalized_email,
        'duplicate_email', b.normalized_email,
        'primary_phone', a.normalized_phone,
        'duplicate_phone', b.normalized_phone,
        'primary_company', a.normalized_company,
        'duplicate_company', b.normalized_company,
        'primary_domain', a.normalized_domain,
        'duplicate_domain', b.normalized_domain
      ),
      'raw', jsonb_build_object(
        'primary', jsonb_build_object(
          'name', a.name, 'email', a.email, 'phone', a.phone, 'company', a.company),
        'duplicate', jsonb_build_object(
          'name', b.name, 'email', b.email, 'phone', b.phone, 'company', b.company)
      )
    ),
    (select count(*) from public.invoices i where i.client_id = r.duplicate_id)
  from ranked r
  join public.clients a on a.id = r.primary_id
  join public.clients b on b.id = r.duplicate_id
  where r.candidate_rank = 1;

  update public.client_dedup_runs
  set summary = (
    select jsonb_build_object(
      'exact_matches', count(*) filter(where classification = 'exact'),
      'review_required', count(*) filter(where classification = 'review_required'),
      'skipped_records', count(*) filter(where status = 'skipped'),
      'affected_invoices', coalesce(sum(affected_invoice_count)
        filter(where classification = 'exact'), 0),
      'data_changed', false
    )
    from public.client_merge_candidates where run_id = v_run_id
  )
  where id = v_run_id;
  return v_run_id;
end
$$;

create or replace function duewatch_ops.attest_client_dedup_gate(
  p_run_id uuid,
  p_gate text,
  p_evidence jsonb,
  p_confirmation text
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_gate = 'foreign_keys' then
    if p_confirmation <> ('VERIFY FOREIGN KEYS ' || p_run_id::text) then
      raise exception 'Confirmation must be exactly: VERIFY FOREIGN KEYS %', p_run_id;
    end if;
    if coalesce(p_evidence->>'environment', '') <> 'staging'
      or coalesce(jsonb_typeof(p_evidence->'unknown_foreign_keys'), '') <> 'array'
      or coalesce(jsonb_array_length(p_evidence->'unknown_foreign_keys'), -1) <> 0
      or coalesce(jsonb_typeof(p_evidence->'missing_foreign_keys'), '') <> 'array'
      or coalesce(jsonb_array_length(p_evidence->'missing_foreign_keys'), -1) <> 0 then
      raise exception 'Foreign-key evidence must be a passing staging report';
    end if;
    update public.client_dedup_runs
    set foreign_keys_verified_at = now(), foreign_key_evidence = p_evidence
    where id = p_run_id and status = 'prepared';
  elsif p_gate = 'integration_tests' then
    if p_confirmation <> ('VERIFY INTEGRATION TESTS ' || p_run_id::text) then
      raise exception 'Confirmation must be exactly: VERIFY INTEGRATION TESTS %', p_run_id;
    end if;
    if coalesce((p_evidence->>'passed')::boolean, false) is not true
      or coalesce((p_evidence->>'transaction_rolled_back')::boolean, false) is not true then
      raise exception 'Integration-test evidence must report pass and rollback';
    end if;
    update public.client_dedup_runs
    set integration_tests_passed_at = now(), integration_test_evidence = p_evidence
    where id = p_run_id and status = 'prepared';
  else
    raise exception 'Unknown gate: %', p_gate;
  end if;
  if not found then raise exception 'Prepared run not found'; end if;
end
$$;

create or replace function duewatch_ops.execute_client_dedup(
  p_run_id uuid,
  p_confirmation text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run public.client_dedup_runs%rowtype;
  c public.client_merge_candidates%rowtype;
  d public.clients%rowtype;
  v_invoice_ids jsonb;
  v_merged integer := 0;
begin
  if not exists (
    select 1 from duewatch_ops.client_dedup_config
    where singleton and execution_enabled
  ) then
    raise exception 'Client dedup execution is disabled';
  end if;
  if exists(select 1 from duewatch_ops.unknown_client_foreign_keys()) then
    raise exception 'Unknown client/invoice foreign keys exist; execution blocked';
  end if;

  select * into v_run from public.client_dedup_runs
  where id = p_run_id for update;
  if not found or v_run.status <> 'prepared' then
    raise exception 'Run is missing or not prepared';
  end if;
  if v_run.foreign_keys_verified_at is null then
    raise exception 'Staging foreign-key verification has not passed';
  end if;
  if v_run.integration_tests_passed_at is null then
    raise exception 'Integration tests have not passed';
  end if;
  if p_confirmation <> ('EXECUTE ' || p_run_id::text) then
    raise exception 'Confirmation must be exactly: EXECUTE %', p_run_id;
  end if;

  update public.client_dedup_runs set status = 'executing' where id = p_run_id;
  for c in
    select mc.* from public.client_merge_candidates mc
    join public.clients dup on dup.id = mc.duplicate_client_id
    where mc.run_id = p_run_id
      and mc.classification = 'exact'
      and mc.rule_code = 'email_with_name_or_company'
      and mc.status in ('ready', 'approved')
    order by dup.created_at desc, dup.id desc
  loop
    select * into d from public.clients
    where id = c.duplicate_client_id for update;
    if not found then
      update public.client_merge_candidates set status = 'skipped' where id = c.id;
      continue;
    end if;

    select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
    into v_invoice_ids from public.invoices where client_id = d.id;
    insert into public.client_merge_audit(
      run_id, candidate_id, user_id, primary_client_id, duplicate_client_id,
      duplicate_snapshot, relationship_snapshot
    ) values (
      p_run_id, c.id, c.user_id, c.primary_client_id, c.duplicate_client_id,
      to_jsonb(d),
      jsonb_build_object(
        'invoice_ids', v_invoice_ids,
        'source_identity_ids', (
          select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
          from public.client_source_identities where client_id = d.id
        ),
        'invoice_count', jsonb_array_length(v_invoice_ids),
        'line_item_count', (select count(*) from public.line_items li
          join public.invoices i on i.id = li.invoice_id where i.client_id = d.id),
        'reminder_count', (select count(*) from public.reminders r
          join public.invoices i on i.id = r.invoice_id where i.client_id = d.id),
        'activity_count', (select count(*) from public.events e
          join public.invoices i on i.id = e.invoice_id where i.client_id = d.id),
        'evidence_count', (select count(*) from public.events e
          join public.invoices i on i.id = e.invoice_id
          where i.client_id = d.id and e.evidence is not null),
        'approval_count', (select count(*) from public.awaiting_signature a
          join public.invoices i on i.id = a.invoice_id where i.client_id = d.id)
      )
    );

    update public.invoices set client_id = c.primary_client_id
    where client_id = d.id;
    update public.client_source_identities set client_id = c.primary_client_id
    where client_id = d.id;
    delete from public.clients where id = d.id;
    update public.client_merge_candidates set status = 'executed' where id = c.id;
    v_merged := v_merged + 1;
  end loop;

  update public.client_dedup_runs
  set status = 'completed', executed_at = now(),
      summary = summary || jsonb_build_object('merged_clients', v_merged)
  where id = p_run_id;
  return jsonb_build_object('run_id', p_run_id, 'merged_clients', v_merged);
exception when others then
  update public.client_dedup_runs set status = 'failed'
  where id = p_run_id and status = 'executing';
  raise;
end
$$;

create or replace function duewatch_ops.rollback_client_dedup(
  p_run_id uuid,
  p_confirmation text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.client_merge_audit%rowtype;
  v_restored integer := 0;
begin
  if p_confirmation <> ('ROLLBACK ' || p_run_id::text) then
    raise exception 'Confirmation must be exactly: ROLLBACK %', p_run_id;
  end if;
  if not exists(select 1 from public.client_dedup_runs
    where id = p_run_id and status = 'completed') then
    raise exception 'Only a completed run can be rolled back';
  end if;

  for a in select * from public.client_merge_audit
    where run_id = p_run_id and rolled_back_at is null
    order by executed_at desc, id desc
  loop
    insert into public.clients(
      id, user_id, name, email, phone, company, notes, created_at, canonical_id
    ) values (
      (a.duplicate_snapshot->>'id')::uuid,
      (a.duplicate_snapshot->>'user_id')::uuid,
      a.duplicate_snapshot->>'name',
      nullif(a.duplicate_snapshot->>'email', ''),
      nullif(a.duplicate_snapshot->>'phone', ''),
      nullif(a.duplicate_snapshot->>'company', ''),
      nullif(a.duplicate_snapshot->>'notes', ''),
      (a.duplicate_snapshot->>'created_at')::timestamptz,
      (a.duplicate_snapshot->>'canonical_id')::uuid
    ) on conflict(id) do nothing;

    update public.invoices set client_id = a.duplicate_client_id
    where id in (
      select jsonb_array_elements_text(
        a.relationship_snapshot->'invoice_ids'
      )::uuid
    );
    update public.client_source_identities set client_id = a.duplicate_client_id
    where id in (
      select jsonb_array_elements_text(
        a.relationship_snapshot->'source_identity_ids'
      )::uuid
    );
    update public.client_merge_audit set rolled_back_at = now() where id = a.id;
    v_restored := v_restored + 1;
  end loop;

  update public.client_dedup_runs
  set status = 'rolled_back', rolled_back_at = now() where id = p_run_id;
  return jsonb_build_object('run_id', p_run_id, 'restored_clients', v_restored);
end
$$;

revoke execute on function duewatch_ops.prepare_client_dedup(uuid)
  from public, anon, authenticated;
revoke execute on function duewatch_ops.attest_client_dedup_gate(uuid,text,jsonb,text)
  from public, anon, authenticated;
revoke execute on function duewatch_ops.execute_client_dedup(uuid,text)
  from public, anon, authenticated;
revoke execute on function duewatch_ops.rollback_client_dedup(uuid,text)
  from public, anon, authenticated;
grant execute on function duewatch_ops.prepare_client_dedup(uuid),
  duewatch_ops.attest_client_dedup_gate(uuid,text,jsonb,text),
  duewatch_ops.execute_client_dedup(uuid,text),
  duewatch_ops.rollback_client_dedup(uuid,text) to service_role;

-- Service-role-only public wrappers for the non-browser operator script.
create or replace function public.admin_prepare_client_dedup(p_user_id uuid)
returns uuid language sql security invoker set search_path = public as $$
  select duewatch_ops.prepare_client_dedup(p_user_id)
$$;
create or replace function public.admin_attest_client_dedup_gate(
  p_run_id uuid, p_gate text, p_evidence jsonb, p_confirmation text
) returns void language sql security invoker set search_path = public as $$
  select duewatch_ops.attest_client_dedup_gate(
    p_run_id, p_gate, p_evidence, p_confirmation
  )
$$;
create or replace function public.admin_execute_client_dedup(
  p_run_id uuid, p_confirmation text
) returns jsonb language sql security invoker set search_path = public as $$
  select duewatch_ops.execute_client_dedup(p_run_id, p_confirmation)
$$;
create or replace function public.admin_rollback_client_dedup(
  p_run_id uuid, p_confirmation text
) returns jsonb language sql security invoker set search_path = public as $$
  select duewatch_ops.rollback_client_dedup(p_run_id, p_confirmation)
$$;

revoke execute on function public.admin_prepare_client_dedup(uuid)
  from public, anon, authenticated;
revoke execute on function public.admin_attest_client_dedup_gate(uuid,text,jsonb,text)
  from public, anon, authenticated;
revoke execute on function public.admin_execute_client_dedup(uuid,text)
  from public, anon, authenticated;
revoke execute on function public.admin_rollback_client_dedup(uuid,text)
  from public, anon, authenticated;
grant execute on function public.admin_prepare_client_dedup(uuid),
  public.admin_attest_client_dedup_gate(uuid,text,jsonb,text),
  public.admin_execute_client_dedup(uuid,text),
  public.admin_rollback_client_dedup(uuid,text) to service_role;

-- Browser-safe creation path. The invoice modal calls this instead of a
-- race-prone cached lookup followed by a direct insert.
create or replace function public.resolve_or_create_client(
  p_user_id uuid,
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_company text default null,
  p_source text default null,
  p_external_id text default null,
  p_provenance jsonb default '{}'::jsonb
) returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_count integer;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_user_id then
    raise exception 'Cannot resolve a client for another user';
  end if;
  if public.normalize_client_text(p_name) is null then
    raise exception 'Client name is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_user_id::text || ':' || coalesce(
      public.normalize_client_email(p_email),
      public.normalize_client_phone(p_phone),
      public.normalize_client_text(p_name)
    ), 0
  ));

  if p_source is not null and p_external_id is not null then
    select client_id into v_id from public.client_source_identities
    where user_id = p_user_id and source = lower(trim(p_source))
      and external_id = trim(p_external_id);
    if found then return v_id; end if;
  end if;

  select count(*) into v_count from public.clients
  where user_id = p_user_id and (
    (
      public.normalize_client_email(p_email) is not null
      and normalized_email = public.normalize_client_email(p_email)
      and (
        normalized_name = public.normalize_client_text(p_name)
        or (
          public.normalize_client_text(p_company) is not null
          and normalized_company = public.normalize_client_text(p_company)
        )
      )
    )
    or (
      p_email is null and p_phone is null and p_company is null
      and normalized_name = public.normalize_client_text(p_name)
    )
  );

  if v_count > 1 then
    raise exception 'Ambiguous client identity; select a client explicitly';
  elsif v_count = 0 then
    insert into public.clients(user_id, name, email, phone, company)
    values(p_user_id, trim(p_name), p_email, p_phone, p_company)
    returning id into v_id;
  else
    select id into v_id from public.clients
    where user_id = p_user_id and (
      (
        public.normalize_client_email(p_email) is not null
        and normalized_email = public.normalize_client_email(p_email)
        and (
          normalized_name = public.normalize_client_text(p_name)
          or (
            public.normalize_client_text(p_company) is not null
            and normalized_company = public.normalize_client_text(p_company)
          )
        )
      )
      or (
        p_email is null and p_phone is null and p_company is null
        and normalized_name = public.normalize_client_text(p_name)
      )
    )
    limit 1;
  end if;

  if p_source is not null and p_external_id is not null then
    insert into public.client_source_identities(
      user_id, client_id, source, external_id, provenance
    ) values (
      p_user_id, v_id, lower(trim(p_source)), trim(p_external_id), p_provenance
    ) on conflict(user_id, source, external_id) do update
      set provenance = public.client_source_identities.provenance
        || excluded.provenance;
  end if;
  return v_id;
end
$$;
revoke execute on function public.resolve_or_create_client(
  uuid,text,text,text,text,text,text,jsonb
) from public, anon;
grant execute on function public.resolve_or_create_client(
  uuid,text,text,text,text,text,text,jsonb
) to authenticated, service_role;
