-- M2G-G5: explicit, tenant-safe DW authority and delegation.
-- Authority determination only. This migration adds no provider integration,
-- execution path, scheduler, or canonical financial mutation.

create table public.company_brain_authority_grants_g5 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  grantor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  grantee_type text not null check (grantee_type = 'DW'),
  grantee_id text not null check (grantee_id = 'DUEWATCH'),
  action text not null check (action in (
    'SEND_REMINDER','SEND_COLLECTION_MESSAGE','APPLY_LATE_FEE',
    'WAIVE_LATE_FEE','SETTLE_INVOICE','WRITE_OFF_INVOICE','ISSUE_REFUND'
  )),
  scope_level text not null check (scope_level in ('COMPANY','CLIENT','ENTITY')),
  scope_fingerprint text not null check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  authority_scope jsonb not null check (jsonb_typeof(authority_scope) = 'object'),
  client_id uuid,
  graph_version_id uuid,
  entity_node_id uuid,
  amount_limit_minor bigint check (amount_limit_minor is null or amount_limit_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  effective_from timestamptz not null,
  expires_at timestamptz,
  channel text,
  approval_requirement text not null check (approval_requirement in ('NONE','FOUNDER')),
  status text not null check (status in ('GRANTED','REVOKED','STALE','INVALIDATED','SUPERSEDED')),
  revision integer not null check (revision > 0),
  proposal_id uuid,
  brain_snapshot_id uuid,
  policy_fingerprint text check (policy_fingerprint is null or policy_fingerprint ~ '^[0-9a-f]{64}$'),
  operating_model_id uuid,
  operating_model_fingerprint text check (operating_model_fingerprint is null or operating_model_fingerprint ~ '^[0-9a-f]{64}$'),
  graph_fingerprint text check (graph_fingerprint is null or graph_fingerprint ~ '^[0-9a-f]{64}$'),
  reviewed_state jsonb not null check (jsonb_typeof(reviewed_state) = 'object'),
  supersedes_grant_id uuid,
  revoked_by uuid references auth.users(id) on delete restrict,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz not null default now(),
  decided_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, idempotency_key),
  constraint company_brain_authority_g5_grantor_tenant_check check (grantor_id = user_id),
  constraint company_brain_authority_g5_revoker_tenant_check check (revoked_by is null or revoked_by = user_id),
  constraint company_brain_authority_g5_client_fk foreign key (user_id, client_id)
    references public.clients(user_id, id) on delete restrict,
  constraint company_brain_authority_g5_entity_fk foreign key (user_id, graph_version_id, entity_node_id)
    references public.company_graph_nodes(user_id, graph_version_id, id) on delete restrict,
  constraint company_brain_authority_g5_proposal_fk foreign key (user_id, proposal_id)
    references public.company_brain_authority_proposals(user_id, id) on delete restrict,
  constraint company_brain_authority_g5_snapshot_fk foreign key (user_id, brain_snapshot_id)
    references public.company_brain_snapshots(user_id, id) on delete restrict,
  constraint company_brain_authority_g5_operating_model_fk foreign key (user_id, operating_model_id)
    references public.company_operating_model_proposals(user_id, id) on delete restrict,
  constraint company_brain_authority_g5_graph_fingerprint_fk foreign key (user_id, graph_fingerprint)
    references public.company_graph_versions(user_id, fingerprint) on delete restrict,
  constraint company_brain_authority_g5_supersedes_fk foreign key (user_id, supersedes_grant_id)
    references public.company_brain_authority_grants_g5(user_id, id) on delete restrict,
  check ((scope_level = 'COMPANY' and client_id is null and graph_version_id is null and entity_node_id is null)
    or (scope_level = 'CLIENT' and client_id is not null and graph_version_id is null and entity_node_id is null)
    or (scope_level = 'ENTITY' and client_id is null and graph_version_id is not null and entity_node_id is not null)),
  check ((scope_level = 'COMPANY'
      and not (authority_scope ? 'clientId') and not (authority_scope ? 'entityNodeId'))
    or (scope_level = 'CLIENT' and authority_scope ->> 'clientId' = client_id::text
      and not (authority_scope ? 'entityNodeId'))
    or (scope_level = 'ENTITY' and authority_scope ->> 'entityNodeId' = entity_node_id::text
      and not (authority_scope ? 'clientId'))),
  check ((action in ('APPLY_LATE_FEE','WAIVE_LATE_FEE','SETTLE_INVOICE','WRITE_OFF_INVOICE','ISSUE_REFUND')
      and amount_limit_minor is not null and currency is not null)
    or (action in ('SEND_REMINDER','SEND_COLLECTION_MESSAGE')
      and amount_limit_minor is null and currency is null)),
  check ((action in ('SEND_REMINDER','SEND_COLLECTION_MESSAGE') and channel is not null and length(btrim(channel)) > 0)
    or (action not in ('SEND_REMINDER','SEND_COLLECTION_MESSAGE') and channel is null)),
  check (expires_at is null or expires_at > effective_from),
  check ((status = 'REVOKED' and revoked_by is not null and revoked_at is not null and length(btrim(revocation_reason)) > 0)
    or (status <> 'REVOKED' and revoked_by is null and revoked_at is null and revocation_reason is null)),
  check (coalesce(authority_scope ->> 'level', '') = scope_level),
  check (coalesce(reviewed_state ->> 'tenantId', '') = user_id::text),
  check (coalesce(reviewed_state ->> 'reviewedAt', '') <> ''),
  check ((operating_model_id is null and operating_model_fingerprint is null)
    or (operating_model_id is not null and operating_model_fingerprint is not null))
);

create index company_brain_authority_g5_current_lookup_idx
  on public.company_brain_authority_grants_g5
  (user_id, grantee_type, grantee_id, action, scope_fingerprint, status, effective_from, expires_at);

create index company_brain_authority_g5_lineage_idx
  on public.company_brain_authority_grants_g5 (user_id, supersedes_grant_id, revision);

create table public.company_brain_authority_grant_provenance_g5 (
  user_id uuid not null references auth.users(id) on delete cascade,
  grant_id uuid not null,
  claim_id uuid not null,
  source_version_id uuid not null,
  required_current boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, grant_id, claim_id, source_version_id),
  constraint company_brain_authority_g5_provenance_grant_fk foreign key (user_id, grant_id)
    references public.company_brain_authority_grants_g5(user_id, id) on delete restrict,
  constraint company_brain_authority_g5_provenance_root_fk foreign key (user_id, claim_id, source_version_id)
    references public.company_brain_claim_roots(user_id, claim_id, source_version_id) on delete restrict
);

create table public.company_brain_authority_revocations_g5 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  grant_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  reason text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, idempotency_key),
  constraint company_brain_authority_g5_revocation_actor_check check (actor_id = user_id),
  constraint company_brain_authority_g5_revocation_grant_fk foreign key (user_id, grant_id)
    references public.company_brain_authority_grants_g5(user_id, id) on delete restrict
);

create table public.company_brain_authority_attempts_g5 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  operation text not null check (operation in ('GRANT','REVOKE')),
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text not null check (outcome in (
    'ACCEPTED','IDEMPOTENT_REPLAY','REJECTED_IDEMPOTENCY_CONFLICT',
    'REJECTED_MALFORMED','REJECTED_TENANT_REFERENCE','REJECTED_STALE_REFERENCE'
  )),
  grant_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  constraint company_brain_authority_g5_attempt_actor_check check (actor_id = user_id),
  constraint company_brain_authority_g5_attempt_grant_fk foreign key (user_id, grant_id)
    references public.company_brain_authority_grants_g5(user_id, id) on delete restrict
);

alter table public.company_brain_authority_grants_g5 enable row level security;
alter table public.company_brain_authority_grant_provenance_g5 enable row level security;
alter table public.company_brain_authority_revocations_g5 enable row level security;
alter table public.company_brain_authority_attempts_g5 enable row level security;

create policy company_brain_authority_grants_g5_owner_read
  on public.company_brain_authority_grants_g5 for select to authenticated
  using ((select auth.uid()) = user_id);
create policy company_brain_authority_grant_provenance_g5_owner_read
  on public.company_brain_authority_grant_provenance_g5 for select to authenticated
  using ((select auth.uid()) = user_id);
create policy company_brain_authority_revocations_g5_owner_read
  on public.company_brain_authority_revocations_g5 for select to authenticated
  using ((select auth.uid()) = user_id);
create policy company_brain_authority_attempts_g5_owner_read
  on public.company_brain_authority_attempts_g5 for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.company_brain_authority_grants_g5,
  public.company_brain_authority_grant_provenance_g5,
  public.company_brain_authority_revocations_g5,
  public.company_brain_authority_attempts_g5
  from public, anon, authenticated;

grant select on public.company_brain_authority_grants_g5,
  public.company_brain_authority_grant_provenance_g5,
  public.company_brain_authority_revocations_g5,
  public.company_brain_authority_attempts_g5
  to authenticated;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.stale_company_brain_authority_for_source_g5()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status and new.status in ('SUPERSEDED','REVOKED','INVALIDATED','FAILED') then
    update public.company_brain_authority_grants_g5 grant_row
    set status = 'STALE'
    where grant_row.user_id = new.user_id
      and grant_row.status = 'GRANTED'
      and exists (
        select 1 from public.company_brain_authority_grant_provenance_g5 provenance
        where provenance.user_id = new.user_id
          and provenance.grant_id = grant_row.id
          and provenance.source_version_id = new.id
          and provenance.required_current
      );
  end if;
  return new;
end;
$$;

create trigger company_brain_authority_g5_source_staleness
after update of status on public.company_brain_source_versions
for each row execute function private.stale_company_brain_authority_for_source_g5();

create or replace function private.stale_company_brain_authority_for_operating_model_g5()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status and new.status in ('STALE','SUPERSEDED') then
    update public.company_brain_authority_grants_g5
    set status = 'STALE'
    where user_id = new.user_id and operating_model_id = new.id and status = 'GRANTED';
  end if;
  return new;
end;
$$;

create trigger company_brain_authority_g5_operating_model_staleness
after update of status on public.company_operating_model_proposals
for each row execute function private.stale_company_brain_authority_for_operating_model_g5();

create or replace function private.stale_company_brain_authority_for_snapshot_g5()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.active and not new.active then
    update public.company_brain_authority_grants_g5
    set status = 'STALE'
    where user_id = new.user_id and brain_snapshot_id = new.id and status = 'GRANTED';
  end if;
  return new;
end;
$$;

create trigger company_brain_authority_g5_snapshot_staleness
after update of active on public.company_brain_snapshots
for each row execute function private.stale_company_brain_authority_for_snapshot_g5();

create or replace function private.stale_company_brain_authority_for_graph_g5()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.active and not new.active then
    update public.company_brain_authority_grants_g5
    set status = 'STALE'
    where user_id = new.user_id
      and status = 'GRANTED'
      and (graph_fingerprint = new.fingerprint or graph_version_id = new.id);
  end if;
  return new;
end;
$$;

create trigger company_brain_authority_g5_graph_staleness
after update of active on public.company_graph_versions
for each row execute function private.stale_company_brain_authority_for_graph_g5();

create or replace function public.grant_company_brain_authority_g5(
  p_idempotency_key text,
  p_grantee_type text,
  p_grantee_id text,
  p_action text,
  p_scope_level text,
  p_authority_scope jsonb,
  p_client_id uuid,
  p_graph_version_id uuid,
  p_entity_node_id uuid,
  p_amount_limit_minor bigint,
  p_currency text,
  p_conditions jsonb,
  p_effective_from timestamptz,
  p_expires_at timestamptz,
  p_channel text,
  p_approval_requirement text,
  p_provenance jsonb,
  p_reviewed_state jsonb,
  p_brain_snapshot_id uuid,
  p_policy_fingerprint text,
  p_operating_model_id uuid,
  p_operating_model_fingerprint text,
  p_graph_fingerprint text,
  p_proposal_id uuid,
  p_supersedes_grant_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_grant_id uuid := gen_random_uuid();
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_predecessor_revision integer;
  v_revision integer := 1;
  v_scope_fingerprint text;
  v_request_fingerprint text;
begin
  if v_user_id is null then raise exception 'COMPANY_BRAIN_AUTHORITY_AUTH_REQUIRED'; end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_grantee_type <> 'DW' or p_grantee_id <> 'DUEWATCH'
    or p_action not in ('SEND_REMINDER','SEND_COLLECTION_MESSAGE','APPLY_LATE_FEE','WAIVE_LATE_FEE','SETTLE_INVOICE','WRITE_OFF_INVOICE','ISSUE_REFUND')
    or p_scope_level not in ('COMPANY','CLIENT','ENTITY')
    or jsonb_typeof(p_authority_scope) <> 'object'
    or p_authority_scope ->> 'level' is distinct from p_scope_level
    or jsonb_typeof(p_conditions) <> 'object'
    or jsonb_typeof(p_reviewed_state) <> 'object'
    or jsonb_typeof(p_provenance) <> 'array' or jsonb_array_length(p_provenance) = 0
    or p_effective_from is null or (p_expires_at is not null and p_expires_at <= p_effective_from)
    or p_approval_requirement not in ('NONE','FOUNDER') then
    raise exception 'COMPANY_BRAIN_AUTHORITY_GRANT_MALFORMED';
  end if;
  if (p_scope_level = 'COMPANY' and (p_client_id is not null or p_graph_version_id is not null or p_entity_node_id is not null))
    or (p_scope_level = 'CLIENT' and (p_client_id is null or p_graph_version_id is not null or p_entity_node_id is not null))
    or (p_scope_level = 'ENTITY' and (p_client_id is not null or p_graph_version_id is null or p_entity_node_id is null)) then
    raise exception 'COMPANY_BRAIN_AUTHORITY_SCOPE_MALFORMED';
  end if;
  if (p_scope_level = 'CLIENT' and p_authority_scope ->> 'clientId' is distinct from p_client_id::text)
    or (p_scope_level = 'ENTITY' and p_authority_scope ->> 'entityNodeId' is distinct from p_entity_node_id::text)
    or (p_scope_level = 'COMPANY' and (p_authority_scope ? 'clientId' or p_authority_scope ? 'entityNodeId')) then
    raise exception 'COMPANY_BRAIN_AUTHORITY_SCOPE_REFERENCE_MISMATCH';
  end if;
  if p_scope_level = 'CLIENT' and not exists (
    select 1 from public.clients where user_id = v_user_id and id = p_client_id
  ) then raise exception 'COMPANY_BRAIN_AUTHORITY_CLIENT_TENANT_MISMATCH'; end if;
  if p_scope_level = 'ENTITY' and not exists (
    select 1 from public.company_graph_nodes node
    join public.company_graph_versions version
      on version.user_id = node.user_id and version.id = node.graph_version_id
    where node.user_id = v_user_id and node.graph_version_id = p_graph_version_id
      and node.id = p_entity_node_id and node.active and not node.revoked
      and node.resolution_state = 'RESOLVED' and version.active
  ) then raise exception 'COMPANY_BRAIN_AUTHORITY_ENTITY_UNRESOLVED'; end if;
  if p_proposal_id is not null and not exists (
    select 1 from public.company_brain_authority_proposals where user_id = v_user_id and id = p_proposal_id
  ) then raise exception 'COMPANY_BRAIN_AUTHORITY_PROPOSAL_TENANT_MISMATCH'; end if;
  if p_operating_model_id is not null and not exists (
    select 1 from public.company_operating_model_proposals
    where user_id = v_user_id and id = p_operating_model_id
      and model_fingerprint = p_operating_model_fingerprint
  ) then raise exception 'COMPANY_BRAIN_AUTHORITY_OPERATING_MODEL_TENANT_MISMATCH'; end if;
  if p_brain_snapshot_id is not null and not exists (
    select 1 from public.company_brain_snapshots where user_id = v_user_id and id = p_brain_snapshot_id and active
  ) then raise exception 'COMPANY_BRAIN_AUTHORITY_SNAPSHOT_STALE'; end if;
  if p_graph_fingerprint is not null and not exists (
    select 1 from public.company_graph_versions
    where user_id = v_user_id and fingerprint = p_graph_fingerprint and active
  ) then raise exception 'COMPANY_BRAIN_AUTHORITY_GRAPH_STALE'; end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_provenance) as item(claim_id uuid, source_version_id uuid, required_current boolean)
    left join public.company_brain_claim_roots root
      on root.user_id = v_user_id and root.claim_id = item.claim_id and root.source_version_id = item.source_version_id
    left join public.company_brain_claims claim
      on claim.user_id = v_user_id and claim.id = item.claim_id
    left join public.company_brain_source_versions source_version
      on source_version.user_id = v_user_id and source_version.id = item.source_version_id
    where root.claim_id is null or claim.id is null or source_version.id is null
      or (coalesce(item.required_current, false) and (not claim.active or source_version.status <> 'ACTIVE'))
  ) then raise exception 'COMPANY_BRAIN_AUTHORITY_PROVENANCE_UNKNOWN_OR_STALE'; end if;

  v_scope_fingerprint := encode(sha256(convert_to(p_authority_scope::text, 'utf8')), 'hex');
  v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'granteeType', p_grantee_type, 'granteeId', p_grantee_id,
    'action', p_action, 'scopeLevel', p_scope_level, 'authorityScope', p_authority_scope,
    'amountLimitMinor', p_amount_limit_minor, 'currency', p_currency,
    'conditions', p_conditions, 'effectiveFrom', p_effective_from,
    'expiresAt', p_expires_at, 'channel', p_channel,
    'approvalRequirement', p_approval_requirement, 'provenance', p_provenance,
    'reviewedState', p_reviewed_state, 'brainSnapshotId', p_brain_snapshot_id,
    'policyFingerprint', p_policy_fingerprint, 'operatingModelId', p_operating_model_id,
    'operatingModelFingerprint', p_operating_model_fingerprint,
    'graphFingerprint', p_graph_fingerprint, 'proposalId', p_proposal_id,
    'supersedesGrantId', p_supersedes_grant_id
  )::text, 'utf8')), 'hex');

  select id, request_fingerprint into v_existing_id, v_existing_fingerprint
  from public.company_brain_authority_grants_g5
  where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if v_existing_id is not null then
    if v_existing_fingerprint <> v_request_fingerprint then
      insert into public.company_brain_authority_attempts_g5
        (user_id, actor_id, operation, idempotency_key, request_fingerprint, outcome, grant_id)
      values (v_user_id, v_user_id, 'GRANT', p_idempotency_key, v_request_fingerprint,
        'REJECTED_IDEMPOTENCY_CONFLICT', v_existing_id);
      return jsonb_build_object('outcome', 'REJECTED_IDEMPOTENCY_CONFLICT', 'grant_id', v_existing_id);
    end if;
    insert into public.company_brain_authority_attempts_g5
      (user_id, actor_id, operation, idempotency_key, request_fingerprint, outcome, grant_id)
    values (v_user_id, v_user_id, 'GRANT', p_idempotency_key, v_request_fingerprint,
      'IDEMPOTENT_REPLAY', v_existing_id);
    return jsonb_build_object('outcome', 'IDEMPOTENT_REPLAY', 'grant_id', v_existing_id);
  end if;

  if p_supersedes_grant_id is not null then
    select revision into v_predecessor_revision
    from public.company_brain_authority_grants_g5
    where user_id = v_user_id and id = p_supersedes_grant_id
    for update;
    if v_predecessor_revision is null then raise exception 'COMPANY_BRAIN_AUTHORITY_PREDECESSOR_TENANT_MISMATCH'; end if;
    v_revision := v_predecessor_revision + 1;
  end if;

  insert into public.company_brain_authority_grants_g5 (
    id, user_id, grantor_id, idempotency_key, request_fingerprint,
    grantee_type, grantee_id, action, scope_level, scope_fingerprint, authority_scope,
    client_id, graph_version_id, entity_node_id, amount_limit_minor, currency,
    conditions, effective_from, expires_at, channel, approval_requirement,
    status, revision, proposal_id, brain_snapshot_id, policy_fingerprint,
    operating_model_id, operating_model_fingerprint, graph_fingerprint,
    reviewed_state, supersedes_grant_id
  ) values (
    v_grant_id, v_user_id, v_user_id, p_idempotency_key, v_request_fingerprint,
    p_grantee_type, p_grantee_id, p_action, p_scope_level, v_scope_fingerprint, p_authority_scope,
    p_client_id, p_graph_version_id, p_entity_node_id, p_amount_limit_minor, upper(p_currency),
    p_conditions, p_effective_from, p_expires_at, upper(p_channel), p_approval_requirement,
    'GRANTED', v_revision, p_proposal_id, p_brain_snapshot_id, p_policy_fingerprint,
    p_operating_model_id, p_operating_model_fingerprint, p_graph_fingerprint,
    jsonb_set(p_reviewed_state, '{tenantId}', to_jsonb(v_user_id::text), true), p_supersedes_grant_id
  );

  insert into public.company_brain_authority_grant_provenance_g5
    (user_id, grant_id, claim_id, source_version_id, required_current)
  select v_user_id, v_grant_id, item.claim_id, item.source_version_id, coalesce(item.required_current, false)
  from jsonb_to_recordset(p_provenance) as item(claim_id uuid, source_version_id uuid, required_current boolean);

  if p_supersedes_grant_id is not null then
    update public.company_brain_authority_grants_g5
    set status = 'SUPERSEDED'
    where user_id = v_user_id and id = p_supersedes_grant_id;
  end if;

  insert into public.company_brain_authority_attempts_g5
    (user_id, actor_id, operation, idempotency_key, request_fingerprint, outcome, grant_id)
  values (v_user_id, v_user_id, 'GRANT', p_idempotency_key, v_request_fingerprint, 'ACCEPTED', v_grant_id);
  return jsonb_build_object('outcome', 'ACCEPTED', 'grant_id', v_grant_id, 'revision', v_revision);
end;
$$;

create or replace function public.revoke_company_brain_authority_g5(
  p_grant_id uuid,
  p_idempotency_key text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_event_id uuid;
  v_existing_grant_id uuid;
  v_existing_fingerprint text;
  v_request_fingerprint text;
begin
  if v_user_id is null then raise exception 'COMPANY_BRAIN_AUTHORITY_AUTH_REQUIRED'; end if;
  if p_grant_id is null or p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_reason is null or btrim(p_reason) = '' then
    raise exception 'COMPANY_BRAIN_AUTHORITY_REVOCATION_MALFORMED';
  end if;
  v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'grantId', p_grant_id, 'idempotencyKey', p_idempotency_key, 'reason', p_reason
  )::text, 'utf8')), 'hex');
  select id, grant_id, request_fingerprint into v_event_id, v_existing_grant_id, v_existing_fingerprint
  from public.company_brain_authority_revocations_g5
  where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if v_event_id is not null then
    if v_existing_grant_id is distinct from p_grant_id or v_existing_fingerprint is distinct from v_request_fingerprint then
      insert into public.company_brain_authority_attempts_g5
        (user_id, actor_id, operation, idempotency_key, request_fingerprint, outcome, grant_id)
      values (v_user_id, v_user_id, 'REVOKE', p_idempotency_key, v_request_fingerprint,
        'REJECTED_IDEMPOTENCY_CONFLICT', v_existing_grant_id);
      return jsonb_build_object('outcome', 'REJECTED_IDEMPOTENCY_CONFLICT', 'grant_id', v_existing_grant_id);
    end if;
    return jsonb_build_object('outcome', 'IDEMPOTENT_REPLAY', 'revocation_id', v_event_id, 'grant_id', p_grant_id);
  end if;
  update public.company_brain_authority_grants_g5
  set status = 'REVOKED', revoked_by = v_user_id, revoked_at = now(), revocation_reason = p_reason
  where user_id = v_user_id and id = p_grant_id and status in ('GRANTED','STALE','INVALIDATED');
  if not found then raise exception 'COMPANY_BRAIN_AUTHORITY_GRANT_MISSING_OR_NOT_CURRENT'; end if;
  insert into public.company_brain_authority_revocations_g5
    (user_id, grant_id, actor_id, idempotency_key, request_fingerprint, reason)
  values (v_user_id, p_grant_id, v_user_id, p_idempotency_key, v_request_fingerprint, p_reason)
  returning id into v_event_id;
  insert into public.company_brain_authority_attempts_g5
    (user_id, actor_id, operation, idempotency_key, request_fingerprint, outcome, grant_id)
  values (v_user_id, v_user_id, 'REVOKE', p_idempotency_key, v_request_fingerprint, 'ACCEPTED', p_grant_id);
  return jsonb_build_object('outcome', 'ACCEPTED', 'revocation_id', v_event_id, 'grant_id', p_grant_id);
end;
$$;

revoke all on function private.stale_company_brain_authority_for_source_g5() from public, anon, authenticated;
revoke all on function private.stale_company_brain_authority_for_operating_model_g5() from public, anon, authenticated;
revoke all on function private.stale_company_brain_authority_for_snapshot_g5() from public, anon, authenticated;
revoke all on function private.stale_company_brain_authority_for_graph_g5() from public, anon, authenticated;

revoke all on function public.grant_company_brain_authority_g5(
  text,text,text,text,text,jsonb,uuid,uuid,uuid,bigint,text,jsonb,timestamptz,timestamptz,
  text,text,jsonb,jsonb,uuid,text,uuid,text,text,uuid,uuid
) from public, anon, authenticated;
revoke all on function public.revoke_company_brain_authority_g5(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.grant_company_brain_authority_g5(
  text,text,text,text,text,jsonb,uuid,uuid,uuid,bigint,text,jsonb,timestamptz,timestamptz,
  text,text,jsonb,jsonb,uuid,text,uuid,text,text,uuid,uuid
) to authenticated;
grant execute on function public.revoke_company_brain_authority_g5(uuid,text,text)
  to authenticated;
