-- M2G-G1: durable, tenant-safe Company Brain substrate.
-- Company Brain is contextual/policy knowledge. It is not a financial ledger.

create table public.company_brain_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  source_identity text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('PROCESSING','COMPLETED','FAILED','INVALIDATED')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, idempotency_key)
);

create table public.company_brain_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stable_identity text not null,
  source_type text not null,
  trust_zone text not null,
  active boolean not null default true,
  current_version_id uuid,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, stable_identity),
  check ((active and revoked_at is null) or (not active and revoked_at is not null))
);

create table public.company_brain_source_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  version_number integer not null check (version_number > 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  source_timestamp timestamptz,
  status text not null check (status in ('PROCESSING','ACTIVE','SUPERSEDED','FAILED','INVALIDATED','REVOKED')),
  ingestion_job_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, source_id, version_number),
  unique (user_id, content_hash),
  constraint company_brain_source_versions_source_fk foreign key (user_id, source_id)
    references public.company_brain_sources(user_id, id) on delete restrict,
  constraint company_brain_source_versions_job_fk foreign key (user_id, ingestion_job_id)
    references public.company_brain_ingestion_jobs(user_id, id) on delete restrict
);

alter table public.company_brain_sources
  add constraint company_brain_sources_current_version_fk
  foreign key (user_id, current_version_id)
  references public.company_brain_source_versions(user_id, id)
  deferrable initially deferred;

create table public.company_brain_artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_version_id uuid not null,
  artifact_type text not null,
  locator text not null,
  classification jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  constraint company_brain_artifacts_source_version_fk foreign key (user_id, source_version_id)
    references public.company_brain_source_versions(user_id, id) on delete restrict
);

create table public.company_brain_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_version_id uuid not null,
  artifact_id uuid not null,
  claim_class text not null,
  claim_type text not null,
  semantic_scope jsonb not null,
  subject_scope jsonb not null default '{}'::jsonb,
  claim_value jsonb not null,
  explicit boolean not null,
  derived boolean not null,
  confidence numeric,
  uncertainty text,
  effective_at timestamptz,
  status text not null,
  assumptions jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  canonical_financial_truth boolean not null default false check (canonical_financial_truth = false),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  constraint company_brain_claims_source_version_fk foreign key (user_id, source_version_id)
    references public.company_brain_source_versions(user_id, id) on delete restrict,
  constraint company_brain_claims_artifact_fk foreign key (user_id, artifact_id)
    references public.company_brain_artifacts(user_id, id) on delete restrict
);

create table public.company_brain_claim_roots (
  user_id uuid not null references auth.users(id) on delete cascade,
  claim_id uuid not null,
  source_version_id uuid not null,
  independent boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, claim_id, source_version_id),
  constraint company_brain_claim_roots_claim_fk foreign key (user_id, claim_id)
    references public.company_brain_claims(user_id, id) on delete restrict,
  constraint company_brain_claim_roots_version_fk foreign key (user_id, source_version_id)
    references public.company_brain_source_versions(user_id, id) on delete restrict
);

create table public.company_brain_conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  topic text not null,
  semantic_scope jsonb not null default '{}'::jsonb,
  status text not null check (status in ('CONFLICTED','RESOLVED','INVALIDATED')),
  revision integer not null default 0 check (revision >= 0),
  resolution_decision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, topic, semantic_scope)
);

create table public.company_brain_conflict_members (
  user_id uuid not null references auth.users(id) on delete cascade,
  conflict_id uuid not null,
  claim_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, conflict_id, claim_id),
  constraint company_brain_conflict_members_conflict_fk foreign key (user_id, conflict_id)
    references public.company_brain_conflicts(user_id, id) on delete restrict,
  constraint company_brain_conflict_members_claim_fk foreign key (user_id, claim_id)
    references public.company_brain_claims(user_id, id) on delete restrict
);

create table public.company_brain_founder_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null,
  decision_type text not null,
  target_type text not null check (target_type in ('CONFLICT','AUTHORITY_PROPOSAL')),
  target_id uuid not null,
  target_revision integer not null check (target_revision > 0),
  prior_state jsonb not null,
  new_state jsonb not null,
  reason text not null check (length(btrim(reason)) > 0),
  provenance jsonb not null,
  supersedes_decision_id uuid,
  revoked_by_decision_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, idempotency_key),
  constraint company_brain_founder_decisions_actor_tenant_check check (actor_id = user_id),
  constraint company_brain_founder_decisions_supersedes_fk foreign key (user_id, supersedes_decision_id)
    references public.company_brain_founder_decisions(user_id, id) on delete restrict,
  constraint company_brain_founder_decisions_revoked_by_fk foreign key (user_id, revoked_by_decision_id)
    references public.company_brain_founder_decisions(user_id, id) on delete restrict
);

create table public.company_brain_founder_decision_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  target_type text not null check (target_type in ('CONFLICT','AUTHORITY_PROPOSAL')),
  target_id uuid not null,
  expected_revision integer not null check (expected_revision >= 0),
  actual_revision integer,
  outcome text not null check (outcome in ('ACCEPTED','REJECTED_STALE')),
  decision_id uuid,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  constraint company_brain_founder_decision_attempts_actor_tenant_check check (actor_id = user_id),
  constraint company_brain_founder_decision_attempts_decision_fk foreign key (user_id, decision_id)
    references public.company_brain_founder_decisions(user_id, id) on delete restrict
);

alter table public.company_brain_conflicts
  add constraint company_brain_conflicts_resolution_fk
  foreign key (user_id, resolution_decision_id)
  references public.company_brain_founder_decisions(user_id, id)
  deferrable initially deferred;

create table public.company_brain_authority_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_class text not null,
  authority_scope jsonb not null,
  evidence_claim_ids jsonb not null,
  status text not null check (status in ('PROPOSED','APPROVED','REJECTED','REVOKED')),
  revision integer not null default 0 check (revision >= 0),
  decision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  constraint company_brain_authority_decision_fk foreign key (user_id, decision_id)
    references public.company_brain_founder_decisions(user_id, id) on delete restrict
);

create table public.company_brain_source_tombstones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  reason text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, source_id),
  constraint company_brain_source_tombstones_source_fk foreign key (user_id, source_id)
    references public.company_brain_sources(user_id, id) on delete restrict,
  constraint company_brain_source_tombstones_actor_tenant_check check (actor_id = user_id)
);

create table public.company_brain_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_version bigint not null check (snapshot_version > 0),
  knowledge_version bigint not null check (knowledge_version >= 0),
  schema_version text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  source_version_ids jsonb not null,
  approved_policy_refs jsonb not null default '[]'::jsonb,
  unresolved_conflict_refs jsonb not null default '[]'::jsonb,
  role_delegation_refs jsonb not null default '[]'::jsonb,
  authority_refs jsonb not null default '[]'::jsonb,
  active_claim_refs jsonb not null default '[]'::jsonb,
  tombstone_watermark bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, snapshot_version),
  unique (user_id, knowledge_version, snapshot_hash)
);

create index company_brain_claims_lookup_idx on public.company_brain_claims
  (user_id, claim_type, active, effective_at);
create index company_brain_claims_scope_gin on public.company_brain_claims using gin (semantic_scope);
create index company_brain_conflicts_lookup_idx on public.company_brain_conflicts
  (user_id, status, topic);
create index company_brain_source_versions_lookup_idx on public.company_brain_source_versions
  (user_id, source_id, version_number desc);
create index company_brain_snapshots_latest_idx on public.company_brain_snapshots
  (user_id, snapshot_version desc);

-- Every public tenant table is RLS-protected. Browser clients are read-only;
-- ingestion writes use the internal worker contract documented for G1.
alter table public.company_brain_ingestion_jobs enable row level security;
alter table public.company_brain_sources enable row level security;
alter table public.company_brain_source_versions enable row level security;
alter table public.company_brain_artifacts enable row level security;
alter table public.company_brain_claims enable row level security;
alter table public.company_brain_claim_roots enable row level security;
alter table public.company_brain_conflicts enable row level security;
alter table public.company_brain_conflict_members enable row level security;
alter table public.company_brain_founder_decisions enable row level security;
alter table public.company_brain_founder_decision_attempts enable row level security;
alter table public.company_brain_authority_proposals enable row level security;
alter table public.company_brain_source_tombstones enable row level security;
alter table public.company_brain_snapshots enable row level security;

create policy company_brain_ingestion_jobs_owner_read on public.company_brain_ingestion_jobs for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_sources_owner_read on public.company_brain_sources for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_source_versions_owner_read on public.company_brain_source_versions for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_artifacts_owner_read on public.company_brain_artifacts for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_claims_owner_read on public.company_brain_claims for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_claim_roots_owner_read on public.company_brain_claim_roots for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_conflicts_owner_read on public.company_brain_conflicts for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_conflict_members_owner_read on public.company_brain_conflict_members for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_founder_decisions_owner_read on public.company_brain_founder_decisions for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_founder_decision_attempts_owner_read on public.company_brain_founder_decision_attempts for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_authority_proposals_owner_read on public.company_brain_authority_proposals for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_source_tombstones_owner_read on public.company_brain_source_tombstones for select to authenticated using ((select auth.uid()) = user_id);
create policy company_brain_snapshots_owner_read on public.company_brain_snapshots for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.company_brain_ingestion_jobs, public.company_brain_sources,
  public.company_brain_source_versions, public.company_brain_artifacts,
  public.company_brain_claims, public.company_brain_claim_roots,
  public.company_brain_conflicts, public.company_brain_conflict_members,
  public.company_brain_founder_decisions, public.company_brain_founder_decision_attempts,
  public.company_brain_authority_proposals,
  public.company_brain_source_tombstones, public.company_brain_snapshots
  from anon, authenticated;

grant select on public.company_brain_ingestion_jobs, public.company_brain_sources,
  public.company_brain_source_versions, public.company_brain_artifacts,
  public.company_brain_claims, public.company_brain_claim_roots,
  public.company_brain_conflicts, public.company_brain_conflict_members,
  public.company_brain_founder_decisions, public.company_brain_founder_decision_attempts,
  public.company_brain_authority_proposals,
  public.company_brain_source_tombstones, public.company_brain_snapshots
  to authenticated;

-- Authenticated, optimistic founder decision boundary. SECURITY DEFINER is
-- intentionally narrow, has an empty search_path, validates auth.uid(), and
-- is executable only by authenticated callers.
create or replace function public.record_company_brain_founder_decision(
  p_idempotency_key text,
  p_target_type text,
  p_target_id uuid,
  p_expected_revision integer,
  p_decision_type text,
  p_prior_state jsonb,
  p_new_state jsonb,
  p_reason text,
  p_provenance jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_current_revision integer;
  v_existing uuid;
  v_decision_id uuid := gen_random_uuid();
  v_supersedes uuid;
  v_fingerprint text := encode(sha256(convert_to(concat_ws('|', p_target_type, p_target_id::text, p_expected_revision::text, p_decision_type, p_prior_state::text, p_new_state::text, p_reason, p_provenance::text), 'utf8')), 'hex');
begin
  if v_user_id is null then raise exception 'COMPANY_BRAIN_AUTH_REQUIRED'; end if;
  if p_target_type not in ('CONFLICT','AUTHORITY_PROPOSAL') or p_target_id is null then raise exception 'COMPANY_BRAIN_SCOPE_INVALID'; end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or p_reason is null or btrim(p_reason) = '' then raise exception 'COMPANY_BRAIN_DECISION_MALFORMED'; end if;
  select id into v_existing from public.company_brain_founder_decisions where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if v_existing is not null then return jsonb_build_object('outcome', 'IDEMPOTENT_REPLAY', 'decision_id', v_existing); end if;

  if p_target_type = 'CONFLICT' then
    select revision into v_current_revision from public.company_brain_conflicts where user_id = v_user_id and id = p_target_id for update;
  else
    select revision into v_current_revision from public.company_brain_authority_proposals where user_id = v_user_id and id = p_target_id and status <> 'REVOKED' for update;
  end if;
  if v_current_revision is null then raise exception 'COMPANY_BRAIN_TARGET_MISSING_OR_REVOKED'; end if;
  if v_current_revision <> p_expected_revision then
    insert into public.company_brain_founder_decision_attempts (
      user_id, actor_id, target_type, target_id, expected_revision,
      actual_revision, outcome, request_fingerprint
    ) values (
      v_user_id, v_user_id, p_target_type, p_target_id, p_expected_revision,
      v_current_revision, 'REJECTED_STALE', v_fingerprint
    );
    return jsonb_build_object('outcome', 'REJECTED_STALE', 'actual_revision', v_current_revision);
  end if;
  select id into v_supersedes from public.company_brain_founder_decisions where user_id = v_user_id and target_type = p_target_type and target_id = p_target_id order by created_at desc limit 1;

  insert into public.company_brain_founder_decisions (
    id, user_id, actor_id, idempotency_key, decision_type, target_type,
    target_id, target_revision, prior_state, new_state, reason, provenance,
    supersedes_decision_id
  ) values (
    v_decision_id, v_user_id, v_user_id, p_idempotency_key, p_decision_type,
    p_target_type, p_target_id, p_expected_revision + 1, p_prior_state,
    p_new_state, p_reason, p_provenance, v_supersedes
  );

  if p_target_type = 'CONFLICT' then
    update public.company_brain_conflicts set status = 'RESOLVED', revision = revision + 1,
      resolution_decision_id = v_decision_id, updated_at = now()
    where user_id = v_user_id and id = p_target_id;
  else
    update public.company_brain_authority_proposals set status = coalesce(p_new_state->>'status','REJECTED'),
      revision = revision + 1, decision_id = v_decision_id, updated_at = now()
    where user_id = v_user_id and id = p_target_id;
  end if;
  insert into public.company_brain_founder_decision_attempts (
    user_id, actor_id, target_type, target_id, expected_revision,
    actual_revision, outcome, decision_id, request_fingerprint
  ) values (
    v_user_id, v_user_id, p_target_type, p_target_id, p_expected_revision,
    p_expected_revision + 1, 'ACCEPTED', v_decision_id, v_fingerprint
  );
  return jsonb_build_object('outcome', 'ACCEPTED', 'decision_id', v_decision_id, 'actual_revision', p_expected_revision + 1);
end;
$$;

create or replace function public.revoke_company_brain_source(
  p_source_id uuid,
  p_reason text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_tombstone_id uuid := gen_random_uuid();
begin
  if v_user_id is null then raise exception 'COMPANY_BRAIN_AUTH_REQUIRED'; end if;
  if p_source_id is null or p_reason is null or btrim(p_reason) = '' then raise exception 'COMPANY_BRAIN_REVOCATION_MALFORMED'; end if;
  update public.company_brain_sources set active = false, revoked_at = now(),
    revocation_reason = p_reason, updated_at = now()
  where user_id = v_user_id and id = p_source_id and active = true;
  if not found then
    select id into v_tombstone_id from public.company_brain_source_tombstones where user_id = v_user_id and source_id = p_source_id;
    if v_tombstone_id is null then raise exception 'COMPANY_BRAIN_SOURCE_MISSING'; end if;
    return v_tombstone_id;
  end if;
  update public.company_brain_source_versions set status = 'REVOKED'
    where user_id = v_user_id and source_id = p_source_id and status in ('PROCESSING','ACTIVE','SUPERSEDED');
  update public.company_brain_artifacts a set active = false, updated_at = now()
    where a.user_id = v_user_id and exists (
      select 1 from public.company_brain_source_versions v where v.user_id = v_user_id and v.source_id = p_source_id and v.id = a.source_version_id
    );
  update public.company_brain_claims c set active = false, status = 'INVALIDATED', updated_at = now()
    where c.user_id = v_user_id and exists (
      select 1 from public.company_brain_claim_roots r join public.company_brain_source_versions v
        on v.user_id = r.user_id and v.id = r.source_version_id
      where r.user_id = v_user_id and r.claim_id = c.id and v.source_id = p_source_id
    );
  insert into public.company_brain_source_tombstones (id, user_id, source_id, actor_id, reason)
    values (v_tombstone_id, v_user_id, p_source_id, v_user_id, p_reason);
  return v_tombstone_id;
end;
$$;

revoke execute on function public.record_company_brain_founder_decision(text,text,uuid,integer,text,jsonb,jsonb,text,jsonb) from public, anon;
revoke execute on function public.revoke_company_brain_source(uuid,text) from public, anon;
grant execute on function public.record_company_brain_founder_decision(text,text,uuid,integer,text,jsonb,jsonb,text,jsonb) to authenticated;
grant execute on function public.revoke_company_brain_source(uuid,text) to authenticated;
