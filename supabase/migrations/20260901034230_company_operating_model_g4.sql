-- M2G-G4: durable, review-only Company Operating Model proposals.
-- Repository-scope migration only. Do not describe as runtime/deployment verified
-- until applied in an isolated Supabase/Postgres environment.

create table public.company_operating_model_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  proposal_key text not null check (proposal_key ~ '^operating-model-[0-9a-f]{24}$'),
  proposal_revision bigint not null check (proposal_revision > 0),
  graph_fingerprint text not null check (graph_fingerprint ~ '^[0-9a-f]{64}$'),
  brain_knowledge_version bigint not null check (brain_knowledge_version >= 0),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  model_fingerprint text not null check (model_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('PROPOSED','BLOCKED','STALE','SUPERSEDED')),
  source_state jsonb not null check (jsonb_typeof(source_state) = 'object'),
  model_payload jsonb not null check (jsonb_typeof(model_payload) = 'object'),
  superseded_by_id uuid,
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (user_id, id),
  unique (user_id, proposal_key),
  unique (user_id, model_fingerprint),
  constraint company_operating_model_graph_fingerprint_fk
    foreign key (user_id, graph_fingerprint)
    references public.company_graph_versions(user_id, fingerprint) on delete restrict,
  constraint company_operating_model_superseded_by_fk
    foreign key (user_id, superseded_by_id)
    references public.company_operating_model_proposals(user_id, id) on delete restrict,
  check ((status in ('PROPOSED','BLOCKED') and invalidated_at is null and superseded_by_id is null)
    or (status = 'STALE' and invalidated_at is not null and superseded_by_id is null)
    or (status = 'SUPERSEDED' and invalidated_at is not null and superseded_by_id is not null)),
  check (model_payload ->> 'tenantId' = user_id::text),
  check (model_payload ->> 'proposalId' = proposal_key),
  check ((model_payload ->> 'revision')::bigint = proposal_revision),
  check (model_payload ->> 'fingerprint' = model_fingerprint),
  check (coalesce((source_state ->> 'knowledgeVersion')::bigint, -1) = brain_knowledge_version),
  check (coalesce(source_state ->> 'fingerprint', '') = source_fingerprint),
  check (coalesce(source_state ->> 'graphFingerprint', '') = graph_fingerprint),
  check (source_state ->> 'asOfDate' is not null),
  check ((source_state ->> 'asOfDate')::date::text = source_state ->> 'asOfDate'),
  check (coalesce(source_state ->> 'asOfDate', '') = coalesce(model_payload ->> 'asOfDate', '')),
  check (coalesce(model_payload -> 'sourceState', 'null'::jsonb) = source_state),
  check (coalesce((model_payload #>> '{boundaries,canonicalMoneyWritable}')::boolean, true) = false),
  check (coalesce((model_payload #>> '{boundaries,authorityGrantable}')::boolean, true) = false),
  check (coalesce((model_payload #>> '{boundaries,canActAutomatically}')::boolean, true) = false),
  check (coalesce((model_payload #>> '{boundaries,operatingModelApproved}')::boolean, true) = false),
  check (coalesce((model_payload #>> '{boundaries,observedDelegationIsAuthority}')::boolean, true) = false),
  check (coalesce((model_payload #>> '{boundaries,dwAuthorityDerived}')::boolean, true) = false)
);

create unique index company_operating_model_one_current_idx
  on public.company_operating_model_proposals (user_id)
  where status in ('PROPOSED','BLOCKED');

create index company_operating_model_replay_idx
  on public.company_operating_model_proposals
  (user_id, proposal_revision desc, created_at desc);

create table public.company_operating_model_proposal_evidence (
  user_id uuid not null references auth.users(id) on delete cascade,
  proposal_id uuid not null,
  claim_id uuid not null,
  source_version_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, proposal_id, claim_id, source_version_id),
  constraint company_operating_model_evidence_proposal_fk
    foreign key (user_id, proposal_id)
    references public.company_operating_model_proposals(user_id, id) on delete restrict,
  constraint company_operating_model_evidence_claim_root_fk
    foreign key (user_id, claim_id, source_version_id)
    references public.company_brain_claim_roots(user_id, claim_id, source_version_id) on delete restrict
);

alter table public.company_operating_model_proposals enable row level security;
alter table public.company_operating_model_proposal_evidence enable row level security;

create policy company_operating_model_proposals_owner_read
  on public.company_operating_model_proposals
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy company_operating_model_evidence_owner_read
  on public.company_operating_model_proposal_evidence
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.company_operating_model_proposals,
  public.company_operating_model_proposal_evidence
  from anon, authenticated;

grant select on public.company_operating_model_proposals,
  public.company_operating_model_proposal_evidence
  to authenticated;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.validate_company_operating_model_provenance(
  p_user_id uuid,
  p_proposal_id uuid
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  select model_payload into v_payload
  from public.company_operating_model_proposals
  where user_id = p_user_id and id = p_proposal_id;

  if v_payload is null then
    return;
  end if;

  if exists (
    with declared as (
      select claim_entry.key::uuid as claim_id, root.value::uuid as source_version_id
      from jsonb_each(coalesce(v_payload -> 'evidenceIndex', '{}'::jsonb)) claim_entry
      cross join lateral jsonb_array_elements_text(
        coalesce(claim_entry.value -> 'rootSourceVersionIds', '[]'::jsonb)
      ) root(value)
    )
    select claim_id, source_version_id from declared
    except
    select claim_id, source_version_id
    from public.company_operating_model_proposal_evidence
    where user_id = p_user_id and proposal_id = p_proposal_id
  ) then
    raise exception 'operating model declared provenance is missing normalized evidence';
  end if;

  if exists (
    select claim_id, source_version_id
    from public.company_operating_model_proposal_evidence
    where user_id = p_user_id and proposal_id = p_proposal_id
    except
    select claim_entry.key::uuid, root.value::uuid
    from jsonb_each(coalesce(v_payload -> 'evidenceIndex', '{}'::jsonb)) claim_entry
    cross join lateral jsonb_array_elements_text(
      coalesce(claim_entry.value -> 'rootSourceVersionIds', '[]'::jsonb)
    ) root(value)
  ) then
    raise exception 'operating model normalized evidence is absent from declared provenance';
  end if;
end;
$$;

create or replace function private.validate_company_operating_model_provenance_trigger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.validate_company_operating_model_provenance(
    case when tg_op = 'DELETE' then old.user_id else new.user_id end,
    case when tg_op = 'DELETE' then old.proposal_id else new.proposal_id end
  );
  return null;
end;
$$;

create constraint trigger company_operating_model_evidence_integrity
after insert or update or delete on public.company_operating_model_proposal_evidence
deferrable initially deferred
for each row execute function private.validate_company_operating_model_provenance_trigger();

create or replace function private.validate_company_operating_model_payload_trigger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.validate_company_operating_model_provenance(new.user_id, new.id);
  return null;
end;
$$;

create constraint trigger company_operating_model_payload_integrity
after insert or update of model_payload on public.company_operating_model_proposals
deferrable initially deferred
for each row execute function private.validate_company_operating_model_payload_trigger();

create or replace function private.validate_company_operating_model_source_state()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_snapshot_active boolean;
  v_snapshot_knowledge_version bigint;
  v_graph_active boolean;
  v_graph_brain_snapshot_id uuid;
  v_graph_fingerprint text;
begin
  select active, brain_snapshot_id, fingerprint
    into v_graph_active, v_graph_brain_snapshot_id, v_graph_fingerprint
  from public.company_graph_versions
  where user_id = new.user_id and fingerprint = new.graph_fingerprint;

  if not found then
    raise exception 'operating model graph version is missing for tenant';
  end if;

  select active, knowledge_version
    into v_snapshot_active, v_snapshot_knowledge_version
  from public.company_brain_snapshots
  where user_id = new.user_id and id = v_graph_brain_snapshot_id;

  if not found then
    raise exception 'operating model graph Brain snapshot is missing for tenant';
  end if;

  if v_snapshot_knowledge_version <> new.brain_knowledge_version then
    raise exception 'operating model Brain knowledge version mismatch';
  end if;

  if v_graph_fingerprint is distinct from new.graph_fingerprint
    or v_graph_fingerprint is distinct from new.source_state ->> 'graphFingerprint' then
    raise exception 'operating model graph fingerprint mismatch';
  end if;

  if new.status in ('PROPOSED','BLOCKED') and (not v_snapshot_active or not v_graph_active) then
    raise exception 'current operating model requires active Brain and graph state';
  end if;

  return new;
end;
$$;

create trigger company_operating_model_source_state_integrity
before insert or update of user_id, graph_fingerprint,
  brain_knowledge_version, source_state, model_payload, status
on public.company_operating_model_proposals
for each row execute function private.validate_company_operating_model_source_state();

create or replace function private.stale_operating_models_for_graph()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.active and not new.active then
    update public.company_operating_model_proposals
    set status = 'STALE', invalidated_at = coalesce(new.invalidated_at, now())
    where user_id = new.user_id
      and graph_fingerprint = new.fingerprint
      and status in ('PROPOSED','BLOCKED');
  end if;
  return new;
end;
$$;

create trigger company_operating_model_graph_staleness
after update of active on public.company_graph_versions
for each row execute function private.stale_operating_models_for_graph();

create or replace function private.stale_operating_models_for_brain_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.active and not new.active then
    update public.company_operating_model_proposals
    set status = 'STALE', invalidated_at = coalesce(new.invalidated_at, now())
    where user_id = new.user_id
      and status in ('PROPOSED','BLOCKED')
      and exists (
        select 1
        from public.company_graph_versions graph_version
        where graph_version.user_id = new.user_id
          and graph_version.fingerprint = company_operating_model_proposals.graph_fingerprint
          and graph_version.brain_snapshot_id = new.id
      );
  end if;
  return new;
end;
$$;

create trigger company_operating_model_brain_staleness
after update of active on public.company_brain_snapshots
for each row execute function private.stale_operating_models_for_brain_snapshot();

revoke all on function private.validate_company_operating_model_provenance(uuid, uuid) from public, anon, authenticated;
revoke all on function private.validate_company_operating_model_provenance_trigger() from public, anon, authenticated;
revoke all on function private.validate_company_operating_model_payload_trigger() from public, anon, authenticated;
revoke all on function private.validate_company_operating_model_source_state() from public, anon, authenticated;
revoke all on function private.stale_operating_models_for_graph() from public, anon, authenticated;
revoke all on function private.stale_operating_models_for_brain_snapshot() from public, anon, authenticated;
