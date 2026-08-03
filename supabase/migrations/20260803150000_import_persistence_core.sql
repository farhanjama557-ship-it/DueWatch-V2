-- Phase 1.5B Checkpoint 1: safe, server-authoritative import persistence
-- core. Takes normalized, eligible importer rows and persists canonical
-- clients and invoices in bounded batches with durable, truthful outcomes.
--
-- Architecture (preserving PR #22's Architecture B):
--   - public.resolve_or_create_client(...)'s signature and matching policy
--     are UNCHANGED. This migration adds a companion wrapper,
--     duewatch_ops.resolve_client_for_import(...), that determines
--     matched-vs-created truthfully under the SAME advisory lock the
--     resolver itself takes internally, without reimplementing or
--     duplicating any matching rule. See that function's own comment for
--     exactly how it avoids a race without touching the resolver.
--   - Every new function below follows the two conventions already
--     established in this repository, combined: internal orchestration
--     functions live in `duewatch_ops` (mirroring PR #22's
--     prepare/execute/rollback functions), but the entry points a
--     founder's own browser session calls are SECURITY DEFINER, granted
--     to `authenticated`, and independently re-check `auth.uid() =
--     p_user_id` inside the function body — the exact pattern
--     `public.resolve_or_create_client` itself already uses. This lets the
--     browser drive batch persistence directly (as it already does for
--     ordinary invoice creation) without granting `authenticated` direct
--     write access to any of these tables.
--   - Every new table is tenant-owned, RLS-enabled, `authenticated`-select-
--     only (writes happen only inside the SECURITY DEFINER functions,
--     never via direct grants) — mirroring PR #22's
--     client_dedup_runs/client_merge_candidates/client_merge_audit tables
--     exactly.
--
-- Scope (Checkpoint 1 only): eligibility revalidation, idempotent batched
-- persistence, minimum recovery mechanics (retry, cancellation, failed-
-- batch rollback, refresh reconstruction). No UI polish, no animations, no
-- AI, no saved mappings, no fuzzy matching — see DUEWATCH_CONTEXT_LOG.md's
-- 2026-08-03 entry for the full deferral list.

-- ============================================================
-- Server-side mirror of the eligibility allowlist
-- ============================================================
-- The browser's own preview outcome/issue codes are never authoritative —
-- this table is this migration's own independent copy of exactly which
-- issue codes block import, verified by reading every makeIssue() call
-- site in src/lib/import/normalize.js (see the identical comment and table
-- in src/lib/importPersistence/eligibility.js, which both derive from the
-- same audit so neither module trusts the other).
create schema if not exists duewatch_ops;

create table if not exists duewatch_ops.import_issue_codes (
  code text primary key,
  blocks_import boolean not null
);
revoke all on duewatch_ops.import_issue_codes from public, anon, authenticated;

insert into duewatch_ops.import_issue_codes(code, blocks_import) values
  ('EMPTY_FILE', true),
  ('HEADERS_ONLY', true),
  ('DUPLICATE_HEADER', true),
  ('MALFORMED_FILE', true),
  ('MISSING_REQUIRED_MAPPING', true),
  ('MISSING_REQUIRED_VALUE', true),
  ('INVALID_AMOUNT', true),
  ('AMBIGUOUS_AMOUNT_FORMAT', true),
  ('INVALID_DATE', true),
  ('AMBIGUOUS_DATE_FORMAT', true),
  ('MIXED_DATE_FORMATS', true),
  ('UNKNOWN_STATUS', true),
  ('PAID_WITHOUT_PAYMENT_DATE', false),
  ('AMOUNT_PAID_EXCEEDS_AMOUNT', true),
  ('PARTIAL_PAYMENT_REVIEW', true),
  ('DUPLICATE_IN_UPLOAD', true),
  ('DUPLICATE_DETECTION_INCOMPLETE', false),
  ('FORMULA_VALUE_UNAVAILABLE', false),
  ('FORMULA_CACHED_VALUE_USED', false),
  ('UNSUPPORTED_CURRENCY', true),
  ('CURRENCY_DECISION_REQUIRED', true),
  ('ROW_COLUMN_COUNT_MISMATCH', false),
  ('FILE_TOO_LARGE', true),
  ('ROW_LIMIT_EXCEEDED', true)
on conflict (code) do update set blocks_import = excluded.blocks_import;

create table if not exists duewatch_ops.import_approved_warning_codes (
  code text primary key references duewatch_ops.import_issue_codes(code)
);
revoke all on duewatch_ops.import_approved_warning_codes from public, anon, authenticated;

insert into duewatch_ops.import_approved_warning_codes(code) values
  ('DUPLICATE_DETECTION_INCOMPLETE'),
  ('FORMULA_CACHED_VALUE_USED'),
  ('FORMULA_VALUE_UNAVAILABLE'),
  ('PAID_WITHOUT_PAYMENT_DATE'),
  ('ROW_COLUMN_COUNT_MISMATCH')
on conflict (code) do nothing;

-- Server-side eligibility re-evaluation. `stable` (not `immutable`) because
-- it reads from the two lookup tables above, whose contents this function
-- depends on. Mirrors src/lib/importPersistence/eligibility.js's
-- evaluateRowEligibility() field-for-field, including the explicit 'void'
-- status block (no supported persistence target exists for it yet — see
-- that module's own comment for why this is deliberate, not an oversight).
create or replace function duewatch_ops.evaluate_row_eligibility(
  p_outcome text,
  p_issue_codes text[],
  p_normalized jsonb
) returns table(eligible boolean, reason_code text)
language plpgsql stable security definer set search_path = duewatch_ops, pg_temp as $$
declare
  v_code text;
  v_blocks boolean;
  v_approved boolean;
begin
  if p_outcome is null or p_outcome not in ('ready', 'ready_with_warnings') then
    if p_outcome = 'review_required' then
      return query select false, 'REVIEW_REQUIRED'; return;
    elsif p_outcome = 'rejected' then
      return query select false, 'REJECTED'; return;
    else
      return query select false, 'UNKNOWN_OUTCOME'; return;
    end if;
  end if;

  if p_issue_codes is not null then
    foreach v_code in array p_issue_codes loop
      select ic.blocks_import into v_blocks
      from duewatch_ops.import_issue_codes ic where ic.code = v_code;

      if v_blocks is null then
        return query select false, 'UNKNOWN_ISSUE_CODE'; return;
      end if;
      if v_blocks then
        return query select false, 'BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME'; return;
      end if;
      if p_outcome = 'ready_with_warnings' then
        select exists(
          select 1 from duewatch_ops.import_approved_warning_codes w where w.code = v_code
        ) into v_approved;
        if not v_approved then
          return query select false, 'UNAPPROVED_WARNING_CODE'; return;
        end if;
      end if;
    end loop;
  end if;

  if coalesce(p_normalized->>'invoice_number', '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;
  if coalesce(p_normalized->>'invoice_date', '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;
  if coalesce(p_normalized->>'amount', '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;
  if p_normalized->>'status' = 'void' then
    return query select false, 'UNSUPPORTED_STATUS_VALUE'; return;
  end if;

  return query select true, null::text;
end
$$;
revoke execute on function duewatch_ops.evaluate_row_eligibility(text, text[], jsonb)
  from public, anon, authenticated;
grant execute on function duewatch_ops.evaluate_row_eligibility(text, text[], jsonb)
  to service_role;

-- ============================================================
-- Tables
-- ============================================================

create table if not exists public.import_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'partially_completed', 'failed', 'cancelled')),
  total_rows integer not null default 0,
  eligible_rows integer not null default 0,
  blocked_rows integer not null default 0,
  next_batch_index integer not null default 0,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique(user_id, idempotency_key)
);
create index if not exists import_runs_user_idx on public.import_runs(user_id, created_at desc);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.import_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_index integer not null,
  status text not null check (status in ('in_progress', 'committed', 'failed')),
  row_count integer not null default 0,
  failure_reason text,
  created_at timestamptz not null default now(),
  unique(run_id, batch_index)
);
create index if not exists import_batches_run_idx on public.import_batches(run_id, batch_index);

create table if not exists public.import_rows (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.import_runs(id) on delete cascade,
  batch_id uuid references public.import_batches(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  row_number integer not null,
  row_idempotency_key text not null,
  material_payload jsonb not null,
  material_payload_hash text not null,
  server_status text not null default 'pending'
    check (server_status in ('pending', 'committed', 'blocked', 'failed')),
  block_reason_code text,
  block_reason_detail jsonb,
  client_id uuid references public.clients(id),
  client_result text check (client_result in ('matched', 'created')),
  invoice_id uuid references public.invoices(id),
  invoice_result text check (invoice_result in ('inserted', 'already_existed')),
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(run_id, row_number),
  unique(user_id, row_idempotency_key)
);
create index if not exists import_rows_run_status_idx
  on public.import_rows(run_id, server_status, row_number);
create index if not exists import_rows_batch_idx on public.import_rows(batch_id);

create table if not exists public.import_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.import_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid references public.import_batches(id) on delete set null,
  row_id uuid references public.import_rows(id) on delete set null,
  event_type text not null check (event_type in (
    'run_created', 'batch_started', 'client_matched', 'client_created',
    'invoice_inserted', 'invoice_already_existed', 'row_blocked',
    'batch_committed', 'batch_failed', 'cancellation_requested',
    'run_partially_completed', 'run_completed', 'run_failed'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists import_events_run_idx on public.import_events(run_id, created_at);

-- ---- tenant-safe composite FKs, matching PR #22's established pattern ----
-- invoices needs the same (user_id, id) unique index clients already got
-- from PR #22's tenant-ownership migration, since import_rows.invoice_id
-- is a new FK target against it.
create unique index if not exists invoices_user_id_id_uidx
  on public.invoices(user_id, id);

do $tenant_fks$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_rows'::regclass
      and conname = 'import_rows_user_id_client_id_fkey' and contype = 'f'
  ) then
    alter table public.import_rows
      add constraint import_rows_user_id_client_id_fkey
      foreign key (user_id, client_id)
      references public.clients(user_id, id)
      on update no action
      on delete set null (client_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_rows'::regclass
      and conname = 'import_rows_user_id_invoice_id_fkey' and contype = 'f'
  ) then
    alter table public.import_rows
      add constraint import_rows_user_id_invoice_id_fkey
      foreign key (user_id, invoice_id)
      references public.invoices(user_id, id)
      on update no action
      on delete set null (invoice_id);
  end if;
end
$tenant_fks$;

-- ============================================================
-- RLS: authenticated may only ever SELECT their own rows. All writes
-- happen inside the SECURITY DEFINER functions below, never via a direct
-- grant — mirrors PR #22's client_dedup_runs/client_merge_candidates/
-- client_merge_audit tables exactly.
-- ============================================================
alter table public.import_runs enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.import_events enable row level security;

drop policy if exists "import_runs_select_own" on public.import_runs;
create policy "import_runs_select_own" on public.import_runs
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_batches_select_own" on public.import_batches;
create policy "import_batches_select_own" on public.import_batches
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_rows_select_own" on public.import_rows;
create policy "import_rows_select_own" on public.import_rows
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_events_select_own" on public.import_events;
create policy "import_events_select_own" on public.import_events
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

grant select on public.import_runs, public.import_batches, public.import_rows, public.import_events
  to authenticated;
grant select, insert, update, delete
  on public.import_runs, public.import_batches, public.import_rows, public.import_events
  to service_role;

-- ============================================================
-- Client resolution wrapper — matched-vs-created truth without a second
-- matching algorithm.
-- ============================================================
-- public.resolve_or_create_client(...) is SECURITY INVOKER and internally
-- requires auth.uid() = p_user_id (see its own definition in
-- 20260726000000_canonical_clients.sql) — the exact same context PR #22's
-- own integration test simulates via set_config('request.jwt.claim.sub',
-- ...). This wrapper establishes that same context so a server-driven
-- batch can call the unmodified resolver at all, and separately determines
-- matched-vs-created WITHOUT re-deriving or duplicating any matching rule:
-- it takes the identical advisory lock the resolver computes internally
-- (same coalesce(normalized_email, normalized_phone, normalized_name)
-- formula — copying a lock *key expression* is not matching logic; the
-- decision of which existing client counts as the same identity stays
-- 100% inside the resolver), holds it for this transaction, and then
-- observes whether the id the resolver returns already existed in this
-- lock-key's identity partition *before* the call.
--
-- An earlier version of this wrapper compared the returned client's
-- created_at to transaction_timestamp(), reasoning that a freshly
-- inserted row would share the transaction's own timestamp. Local
-- Postgres smoke testing (a real multi-row batch, two rows sharing one
-- client, both processed in the same transaction) proved that wrong:
-- transaction_timestamp() — like now() — is frozen at transaction START,
-- not evaluated per-statement, so EVERY row inserted anywhere in the same
-- transaction carries an identical created_at. The second row's "matched"
-- client (created moments earlier by the first row, same transaction) was
-- misreported as "created" a second time. Fixed by snapshotting which
-- client ids already exist in this identity's lock-key partition BEFORE
-- calling the resolver, then checking set membership after — this is
-- race-free (the advisory lock is held across both the snapshot and the
-- call, so no concurrent transaction can insert into this same partition
-- in between) and correctly treats "matched a client created earlier in
-- this same transaction" as a match, not a create.
create or replace function duewatch_ops.resolve_client_for_import(
  p_user_id uuid,
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_company text default null,
  p_source text default null,
  p_external_id text default null,
  p_provenance jsonb default '{}'::jsonb
) returns table(client_id uuid, was_created boolean)
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_client_id uuid;
  v_lock_key bigint;
  v_existing_ids uuid[];
begin
  v_lock_key := hashtextextended(
    p_user_id::text || ':' || coalesce(
      public.normalize_client_email(p_email),
      public.normalize_client_phone(p_phone),
      public.normalize_client_text(p_name)
    ), 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- Every client sharing this identity's lock-key partition, before the
  -- resolver runs. Reuses only the lock-key EXPRESSION (identical to the
  -- resolver's own internal lock and to public.resolve_or_create_client's
  -- own lock above it) to scope this existence check — never a match
  -- *decision* — so this stays a wrapper around PR #22's resolver, not a
  -- second matching algorithm.
  select coalesce(array_agg(c.id), array[]::uuid[]) into v_existing_ids
  from public.clients c
  where c.user_id = p_user_id
    and hashtextextended(
      p_user_id::text || ':' || coalesce(
        public.normalize_client_email(c.email),
        public.normalize_client_phone(c.phone),
        public.normalize_client_text(c.name)
      ), 0
    ) = v_lock_key;

  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_client_id := public.resolve_or_create_client(
    p_user_id, p_name, p_email, p_phone, p_company, p_source, p_external_id, p_provenance
  );

  return query select v_client_id, not (v_client_id = any(v_existing_ids));
end
$$;
revoke execute on function duewatch_ops.resolve_client_for_import(
  uuid, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function duewatch_ops.resolve_client_for_import(
  uuid, text, text, text, text, text, text, jsonb
) to service_role;

-- ============================================================
-- start_import_run — idempotent run creation + server-side row
-- revalidation. Called once per "click Start Import."
-- ============================================================
-- p_rows: jsonb array of { row_number, outcome, issue_codes: text[],
-- normalized: {...material fields...} } — exactly the shape the browser's
-- eligibility.js already evaluates client-side; this function re-evaluates
-- every row from scratch rather than trusting any eligibility claim in the
-- payload.
create or replace function public.start_import_run(
  p_user_id uuid,
  p_idempotency_key text,
  p_rows jsonb
) returns uuid
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_run_id uuid;
  v_existing_run_id uuid;
  v_row jsonb;
  v_blocked_row record;
  v_eligible boolean;
  v_reason text;
  v_payload jsonb;
  v_hash text;
  v_row_key text;
  v_total integer := 0;
  v_eligible_count integer := 0;
  v_blocked_count integer := 0;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_user_id then
    raise exception 'Cannot start an import run for another user';
  end if;
  if p_idempotency_key is null or trim(p_idempotency_key) = '' then
    raise exception 'idempotency key is required';
  end if;

  -- Idempotent run creation: the same key for the same user always
  -- returns the same run, never creates a second one.
  select id into v_existing_run_id from public.import_runs
  where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if v_existing_run_id is not null then
    return v_existing_run_id;
  end if;

  v_run_id := gen_random_uuid();
  v_total := jsonb_array_length(p_rows);

  -- Parent row inserted FIRST — import_rows.run_id is a foreign key
  -- against this table, so the run must exist before any row referencing
  -- it can be inserted. eligible_rows/blocked_rows start at 0 and are
  -- corrected by the UPDATE after the loop below, once they're known.
  insert into public.import_runs(
    id, user_id, idempotency_key, status, total_rows, started_at
  ) values (
    v_run_id, p_user_id, p_idempotency_key, 'in_progress', v_total, now()
  );

  for v_row in select * from jsonb_array_elements(p_rows) loop
    select e.eligible, e.reason_code into v_eligible, v_reason
    from duewatch_ops.evaluate_row_eligibility(
      v_row->>'outcome',
      case when v_row->'issue_codes' is null then null
        else array(select jsonb_array_elements_text(v_row->'issue_codes')) end,
      coalesce(v_row->'normalized', '{}'::jsonb)
    ) e;

    v_payload := jsonb_build_object(
      'user_id', p_user_id::text,
      'client_name', v_row->'normalized'->>'client_name',
      'client_company', v_row->'normalized'->>'client_company',
      'client_email', v_row->'normalized'->>'client_email',
      'client_phone', v_row->'normalized'->>'client_phone',
      'source_system', v_row->'normalized'->>'source_system',
      'source_client_id', v_row->'normalized'->>'source_client_id',
      'invoice_number', v_row->'normalized'->>'invoice_number',
      'source_invoice_id', v_row->'normalized'->>'source_invoice_id',
      'invoice_date', v_row->'normalized'->>'invoice_date',
      'due_date', v_row->'normalized'->>'due_date',
      'amount', v_row->'normalized'->>'amount',
      'currency', v_row->'normalized'->>'currency',
      'status', v_row->'normalized'->>'status',
      'amount_paid', v_row->'normalized'->>'amount_paid',
      'payment_date', v_row->'normalized'->>'payment_date'
    );
    v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
    v_row_key := v_run_id::text || ':' || (v_row->>'row_number');

    if v_eligible then
      v_eligible_count := v_eligible_count + 1;
      insert into public.import_rows(
        run_id, user_id, row_number, row_idempotency_key,
        material_payload, material_payload_hash, server_status
      ) values (
        v_run_id, p_user_id, (v_row->>'row_number')::integer, v_row_key,
        v_payload, v_hash, 'pending'
      );
    else
      v_blocked_count := v_blocked_count + 1;
      insert into public.import_rows(
        run_id, user_id, row_number, row_idempotency_key,
        material_payload, material_payload_hash, server_status,
        block_reason_code, block_reason_detail
      ) values (
        v_run_id, p_user_id, (v_row->>'row_number')::integer, v_row_key,
        v_payload, v_hash, 'blocked',
        v_reason, jsonb_build_object('outcome', v_row->>'outcome')
      );
    end if;
  end loop;

  update public.import_runs
  set eligible_rows = v_eligible_count, blocked_rows = v_blocked_count
  where id = v_run_id;

  insert into public.import_events(run_id, user_id, event_type, detail)
  values (v_run_id, p_user_id, 'run_created', jsonb_build_object(
    'total_rows', v_total, 'eligible_rows', v_eligible_count, 'blocked_rows', v_blocked_count
  ));
  for v_blocked_row in
    select id, block_reason_code from public.import_rows
    where run_id = v_run_id and server_status = 'blocked'
  loop
    insert into public.import_events(run_id, user_id, row_id, event_type, detail)
    values (v_run_id, p_user_id, v_blocked_row.id, 'row_blocked',
      jsonb_build_object('reason_code', v_blocked_row.block_reason_code));
  end loop;

  return v_run_id;
end
$$;
revoke execute on function public.start_import_run(uuid, text, jsonb)
  from public, anon;
grant execute on function public.start_import_run(uuid, text, jsonb) to authenticated, service_role;

-- ============================================================
-- process_import_batch — claims and transactionally persists the next
-- pending batch (bounded to 200 rows). Call repeatedly from the browser
-- until the returned status is 'completed', 'partially_completed', or
-- 'cancelled'.
-- ============================================================
create or replace function public.process_import_batch(
  p_run_id uuid,
  p_batch_size integer default 200
) returns jsonb
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_run public.import_runs%rowtype;
  v_batch_index integer;
  v_batch_id uuid;
  v_row public.import_rows%rowtype;
  v_client_id uuid;
  v_was_created boolean;
  v_invoice_id uuid;
  v_invoice_result text;
  v_paid boolean;
  v_amount_paid numeric(12, 2);
  v_lock_key bigint;
  v_row_count integer := 0;
  v_remaining integer;
  v_client_row jsonb;
begin
  select * into v_run from public.import_runs where id = p_run_id for update;
  if not found then
    raise exception 'Import run not found';
  end if;
  if (select auth.uid()) is null or (select auth.uid()) <> v_run.user_id then
    raise exception 'Cannot process a batch for another user''s import run';
  end if;

  if v_run.status in ('completed', 'partially_completed', 'failed', 'cancelled') then
    return jsonb_build_object('status', v_run.status, 'run_id', p_run_id);
  end if;

  -- Cancellation is observed BETWEEN batches, never mid-batch: checked
  -- here, before any new batch is claimed, never inside the loop below.
  if v_run.cancel_requested_at is not null then
    update public.import_runs set status = 'cancelled', completed_at = now()
    where id = p_run_id;
    insert into public.import_events(run_id, user_id, event_type)
    values (p_run_id, v_run.user_id, 'run_completed');
    return jsonb_build_object('status', 'cancelled', 'run_id', p_run_id);
  end if;

  -- Claim up to p_batch_size PENDING rows. FOR UPDATE SKIP LOCKED means a
  -- second concurrent call for the same run claims a *different* set of
  -- rows (or none) rather than racing on the same ones.
  create temporary table if not exists _claimed_rows (id uuid primary key) on commit drop;
  delete from _claimed_rows;
  insert into _claimed_rows
  select id from public.import_rows
  where run_id = p_run_id and batch_id is null and server_status = 'pending'
  order by row_number
  limit p_batch_size
  for update skip locked;

  select count(*) into v_row_count from _claimed_rows;

  if v_row_count = 0 then
    select count(*) into v_remaining from public.import_rows
    where run_id = p_run_id and server_status = 'pending';
    if v_remaining > 0 then
      -- Another concurrent worker holds the remaining pending rows right
      -- now; this run is not finished, just not claimable by us this call.
      return jsonb_build_object('status', 'in_progress', 'run_id', p_run_id, 'claimed', 0);
    end if;

    select count(*) into v_remaining from public.import_rows
    where run_id = p_run_id and server_status in ('blocked', 'failed');
    update public.import_runs
    set status = case when v_remaining > 0 then 'partially_completed' else 'completed' end,
        completed_at = now()
    where id = p_run_id;
    insert into public.import_events(run_id, user_id, event_type)
    values (p_run_id, v_run.user_id,
      case when v_remaining > 0 then 'run_partially_completed' else 'run_completed' end);
    return jsonb_build_object(
      'status', case when v_remaining > 0 then 'partially_completed' else 'completed' end,
      'run_id', p_run_id
    );
  end if;

  update public.import_runs set next_batch_index = next_batch_index + 1
  where id = p_run_id
  returning next_batch_index - 1 into v_batch_index;

  -- The batch row is inserted FIRST (status='in_progress') so that
  -- per-row UPDATEs referencing batch_id — via either the happy path or
  -- the per-row exception handler below — never violate
  -- import_rows_batch_id_fkey by pointing at a batch that doesn't exist
  -- yet. Its status is corrected to 'committed' or 'failed' below, once
  -- known.
  v_batch_id := gen_random_uuid();
  insert into public.import_batches(id, run_id, user_id, batch_index, status, row_count)
  values (v_batch_id, p_run_id, v_run.user_id, v_batch_index, 'in_progress', v_row_count);

  insert into public.import_events(run_id, user_id, event_type, detail)
  values (p_run_id, v_run.user_id, 'batch_started', jsonb_build_object('batch_index', v_batch_index, 'row_count', v_row_count));

  -- Nested block = implicit savepoint. Any unexpected exception here rolls
  -- back every row-level write in this batch (invoice inserts, client
  -- creates via the resolver, import_rows updates) while letting the
  -- OUTER block still record a truthful 'batch_failed' fact afterward —
  -- the failure record itself is not part of what gets rolled back.
  begin
    for v_row in
      select r.* from public.import_rows r
      join _claimed_rows c on c.id = r.id
      order by r.row_number
    loop
      begin
        select * from duewatch_ops.resolve_client_for_import(
          v_run.user_id,
          v_row.material_payload->>'client_name',
          v_row.material_payload->>'client_email',
          v_row.material_payload->>'client_phone',
          v_row.material_payload->>'client_company',
          v_row.material_payload->>'source_system',
          v_row.material_payload->>'source_client_id',
          jsonb_build_object('import_run_id', p_run_id, 'row_id', v_row.id)
        ) into v_client_id, v_was_created;
      exception when others then
        update public.import_rows
        set server_status = 'blocked',
            block_reason_code = 'CLIENT_RESOLUTION_FAILED',
            block_reason_detail = jsonb_build_object('message', sqlerrm),
            batch_id = v_batch_id
        where id = v_row.id;
        insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
        values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
          jsonb_build_object('reason_code', 'CLIENT_RESOLUTION_FAILED', 'message', sqlerrm));
        continue;
      end;

      -- Invoice insert-or-skip, under a lock keyed on the invoice's own
      -- material identity so two concurrent workers can never both decide
      -- "this doesn't exist yet" for the same logical invoice. Prefers
      -- source_invoice_id (paired with source_system) when present —
      -- case-sensitive, per the existing external-ID convention — else
      -- falls back to (client_id, invoice_number).
      -- Parentheses around each ->> extraction are required here: ->> and
      -- || share the same operator precedence in Postgres and associate
      -- left-to-right, so an unparenthesized chain like
      -- `a->>'x' || ':' || a->>'y'` actually parses as
      -- `(((a->>'x') || ':') || a) ->> 'y'` — concatenating the whole
      -- jsonb value into text and then applying ->> to that text, which
      -- errors. Caught via local Postgres smoke testing.
      v_lock_key := hashtextextended(
        v_run.user_id::text || ':inv:' || coalesce(
          (v_row.material_payload->>'source_system') || ':' || (v_row.material_payload->>'source_invoice_id'),
          v_client_id::text || ':' || (v_row.material_payload->>'invoice_number')
        ), 0
      );
      perform pg_advisory_xact_lock(v_lock_key);

      select i.id into v_invoice_id from public.invoices i
      where i.user_id = v_run.user_id
        and i.client_id = v_client_id
        and i.inv_num = (v_row.material_payload->>'invoice_number');

      -- status -> paid boolean translation (the real schema has no status
      -- column; this is Phase 1.5B's one authoritative, locked
      -- translation, never re-derived elsewhere):
      --   'paid'                          -> paid = true
      --   'partial' / 'draft' / 'sent' /
      --   'overdue' / null (blank)        -> paid = false
      --   'void'                          -> blocked before reaching here
      --                                      (see evaluate_row_eligibility)
      -- coalesce is required: `null = 'paid'` evaluates to NULL, not
      -- false, and invoices.paid is not-null — a blank/omitted status
      -- must resolve to paid = false, not an unassigned NULL.
      v_paid := coalesce(v_row.material_payload->>'status', '') = 'paid';
      v_amount_paid := case
        when v_row.material_payload->>'amount_paid' is not null
          then (v_row.material_payload->>'amount_paid')::numeric(12,2)
        when v_paid then (v_row.material_payload->>'amount')::numeric(12,2)
        else 0
      end;

      if v_invoice_id is not null then
        v_invoice_result := 'already_existed';
      else
        insert into public.invoices(
          user_id, client_id, inv_num, amount, amount_paid,
          inv_date, due_date, paid
        ) values (
          v_run.user_id, v_client_id,
          v_row.material_payload->>'invoice_number',
          (v_row.material_payload->>'amount')::numeric(12,2),
          v_amount_paid,
          (v_row.material_payload->>'invoice_date')::date,
          nullif(v_row.material_payload->>'due_date', '')::date,
          v_paid
        )
        returning id into v_invoice_id;
        v_invoice_result := 'inserted';
      end if;

      update public.import_rows
      set server_status = 'committed',
          batch_id = v_batch_id,
          client_id = v_client_id,
          client_result = case when v_was_created then 'created' else 'matched' end,
          invoice_id = v_invoice_id,
          invoice_result = v_invoice_result,
          committed_at = now()
      where id = v_row.id;

      insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
      values (p_run_id, v_run.user_id, v_batch_id, v_row.id,
        case when v_was_created then 'client_created' else 'client_matched' end,
        jsonb_build_object('client_id', v_client_id));
      insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
      values (p_run_id, v_run.user_id, v_batch_id, v_row.id,
        case when v_invoice_result = 'inserted' then 'invoice_inserted' else 'invoice_already_existed' end,
        jsonb_build_object('invoice_id', v_invoice_id));
    end loop;

    -- Batch row committed only now, once every claimed row in it has a
    -- durable outcome (committed or blocked) — this UPDATE and every
    -- import_rows/import_events write above are part of the SAME
    -- transaction as the function call itself, so they commit together
    -- or not at all. v_batch_id/the import_batches row were created
    -- before the loop (status='in_progress') precisely so per-row writes
    -- above never violate import_rows_batch_id_fkey; this just corrects
    -- the status now that the outcome is known.
    update public.import_batches
    set status = 'committed', row_count = v_row_count
    where id = v_batch_id;
    insert into public.import_events(run_id, user_id, batch_id, event_type, detail)
    values (p_run_id, v_run.user_id, v_batch_id, 'batch_committed', jsonb_build_object('row_count', v_row_count));
  exception when others then
    -- Savepoint rollback undid every row-level write above; the claimed
    -- rows are back to server_status='pending', batch_id=null — exactly
    -- as if this call never happened, safe to retry. The import_batches
    -- row itself (status='in_progress') was inserted before the savepoint
    -- began and is NOT rolled back, so it must be corrected via UPDATE,
    -- not re-inserted.
    update public.import_batches
    set status = 'failed', failure_reason = sqlerrm
    where id = v_batch_id;
    insert into public.import_events(run_id, user_id, batch_id, event_type, detail)
    values (p_run_id, v_run.user_id, v_batch_id, 'batch_failed', jsonb_build_object('message', sqlerrm));
    return jsonb_build_object('status', 'batch_failed', 'run_id', p_run_id, 'reason', sqlerrm);
  end;

  return jsonb_build_object('status', 'in_progress', 'run_id', p_run_id, 'committed', v_row_count);
end
$$;
revoke execute on function public.process_import_batch(uuid, integer) from public, anon;
grant execute on function public.process_import_batch(uuid, integer) to authenticated, service_role;

-- ============================================================
-- request_import_cancellation — idempotent; cancellation is observed
-- between batches by process_import_batch, never mid-batch.
-- ============================================================
create or replace function public.request_import_cancellation(p_run_id uuid)
returns void
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_user_id uuid;
begin
  select user_id into v_user_id from public.import_runs where id = p_run_id for update;
  if not found then
    raise exception 'Import run not found';
  end if;
  if (select auth.uid()) is null or (select auth.uid()) <> v_user_id then
    raise exception 'Cannot cancel another user''s import run';
  end if;

  update public.import_runs
  set cancel_requested_at = coalesce(cancel_requested_at, now())
  where id = p_run_id;

  insert into public.import_events(run_id, user_id, event_type)
  values (p_run_id, v_user_id, 'cancellation_requested');
end
$$;
revoke execute on function public.request_import_cancellation(uuid) from public, anon;
grant execute on function public.request_import_cancellation(uuid) to authenticated, service_role;

-- ============================================================
-- Postconditions
-- ============================================================
do $postconditions$
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename in ('import_runs', 'import_batches', 'import_rows', 'import_events')
    having count(*) = 4
  ) then
    raise exception 'Not all four import persistence tables were created';
  end if;

  if (select execution_enabled from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution must remain disabled';
  end if;
end
$postconditions$;
