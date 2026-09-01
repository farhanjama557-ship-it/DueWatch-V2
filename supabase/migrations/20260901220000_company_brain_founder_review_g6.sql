-- M2G-G6: durable founder review of the Company Brain.
--
-- This migration stores what the founder confirmed, corrected, rejected, held
-- or deferred about DW's understanding of the company. It deliberately adds no
-- authority path: DW standing authority is created only by the G5
-- grant_company_brain_authority_g5 RPC, and every review revision carries a
-- structurally false authority_granted column to make that non-negotiable at
-- the storage layer. It adds no provider integration, no execution path, no
-- scheduler, and no canonical financial mutation.

create table public.company_brain_founder_review_items_g6 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  review_key text not null check (review_key ~ '^review-[0-9a-f]{32}$'),
  category text not null check (category in (
    'COMPANY_UNDERSTANDING','CONFLICTS','OPERATING_MODEL','ROLES',
    'AUTHORITY','AUTHORITY_PROPOSALS','SOURCE_FRESHNESS'
  )),
  item_type text not null check (item_type in (
    'UNDERSTANDING','POLICY_OR_RULE','CONFLICT','OPERATING_MODEL',
    'ROLE_OR_RESPONSIBILITY','DELEGATION','AUTHORITY_PROPOSAL',
    'AUTHORITY_STATE','STALE_OR_CHANGED_ITEM'
  )),
  subject_type text not null check (length(btrim(subject_type)) > 0),
  subject_id text not null check (length(btrim(subject_id)) > 0),
  scope_level text not null check (scope_level in ('COMPANY','CLIENT','ROLE','ENTITY','WORKFLOW','DOCUMENT','INTERACTION','HISTORICAL')),
  review_scope jsonb not null default '{}'::jsonb check (jsonb_typeof(review_scope) = 'object'),
  client_id uuid,
  conflict_id uuid,
  operating_model_id uuid,
  authority_proposal_id uuid,
  authority_grant_id uuid,
  -- Company Brain understanding is never canonical financial truth.
  canonical_financial_truth boolean not null default false check (canonical_financial_truth = false),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, review_key),
  constraint company_brain_founder_review_g6_client_fk foreign key (user_id, client_id)
    references public.clients(user_id, id) on delete restrict,
  constraint company_brain_founder_review_g6_conflict_fk foreign key (user_id, conflict_id)
    references public.company_brain_conflicts(user_id, id) on delete restrict,
  constraint company_brain_founder_review_g6_operating_model_fk foreign key (user_id, operating_model_id)
    references public.company_operating_model_proposals(user_id, id) on delete restrict,
  constraint company_brain_founder_review_g6_proposal_fk foreign key (user_id, authority_proposal_id)
    references public.company_brain_authority_proposals(user_id, id) on delete restrict,
  constraint company_brain_founder_review_g6_grant_fk foreign key (user_id, authority_grant_id)
    references public.company_brain_authority_grants_g5(user_id, id) on delete restrict,
  check (coalesce(review_scope ->> 'level', scope_level) = scope_level),
  check ((scope_level = 'CLIENT') or client_id is null),
  -- An authority item is a projection of G5 state; it is never reviewable here.
  check ((item_type in ('AUTHORITY_PROPOSAL','AUTHORITY_STATE'))
    or (authority_proposal_id is null and authority_grant_id is null))
);

create table public.company_brain_founder_review_revisions_g6 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  review_item_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  actor_role text not null check (actor_role = 'FOUNDER'),
  revision integer not null check (revision > 0),
  review_action text not null check (review_action in ('APPROVE','EDIT','REJECT','HOLD','DEFER')),
  review_status text not null check (review_status in (
    'APPROVED','EDITED','REJECTED','HELD','DEFERRED','SUPERSEDED'
  )),
  subject_fingerprint text not null check (subject_fingerprint ~ '^[0-9a-f]{64}$'),
  proposed_value jsonb,
  reviewed_value jsonb,
  reason text,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_revision_id uuid,
  -- The G6 anti-escalation invariant, enforced by the database itself:
  -- no founder review revision, of any action, ever grants DW authority.
  authority_granted boolean not null default false check (authority_granted = false),
  authority_impact text not null default 'NONE' check (authority_impact = 'NONE'),
  -- A rejection refuses a proposition; it never asserts the inverse.
  asserts_inverse_proposition boolean not null default false check (asserts_inverse_proposition = false),
  -- Conflicts are resolved only by company_brain_founder_decisions (G3).
  resolves_conflict boolean not null default false check (resolves_conflict = false),
  canonical_money_mutated boolean not null default false check (canonical_money_mutated = false),
  executed boolean not null default false check (executed = false),
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, idempotency_key),
  unique (user_id, review_item_id, revision),
  constraint company_brain_founder_review_revisions_g6_actor_tenant_check check (actor_id = user_id),
  constraint company_brain_founder_review_revisions_g6_item_fk foreign key (user_id, review_item_id)
    references public.company_brain_founder_review_items_g6(user_id, id) on delete restrict,
  constraint company_brain_founder_review_revisions_g6_supersedes_fk foreign key (user_id, supersedes_revision_id)
    references public.company_brain_founder_review_revisions_g6(user_id, id) on delete restrict,
  check ((review_action = 'EDIT' and reviewed_value is not null)
    or (review_action <> 'EDIT' and reviewed_value is null)),
  check ((review_action = 'APPROVE' and review_status = 'APPROVED')
    or (review_action = 'EDIT' and review_status = 'EDITED')
    or (review_action = 'REJECT' and review_status = 'REJECTED')
    or (review_action = 'HOLD' and review_status = 'HELD')
    or (review_action = 'DEFER' and review_status = 'DEFERRED')
    or review_status = 'SUPERSEDED')
);

create table public.company_brain_founder_review_evidence_g6 (
  user_id uuid not null references auth.users(id) on delete cascade,
  revision_id uuid not null,
  claim_id uuid not null,
  source_version_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, revision_id, claim_id, source_version_id),
  constraint company_brain_founder_review_evidence_g6_revision_fk foreign key (user_id, revision_id)
    references public.company_brain_founder_review_revisions_g6(user_id, id) on delete restrict,
  constraint company_brain_founder_review_evidence_g6_root_fk foreign key (user_id, claim_id, source_version_id)
    references public.company_brain_claim_roots(user_id, claim_id, source_version_id) on delete restrict
);

create table public.company_brain_founder_review_attempts_g6 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  review_item_id uuid,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text not null check (outcome in (
    'ACCEPTED','IDEMPOTENT_REPLAY','REJECTED_IDEMPOTENCY_CONFLICT',
    'REJECTED_STALE_REVISION','REJECTED_SUBJECT_CHANGED','REJECTED_ACTION_UNAVAILABLE'
  )),
  expected_revision integer,
  actual_revision integer,
  revision_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  constraint company_brain_founder_review_attempts_g6_actor_tenant_check check (actor_id = user_id),
  constraint company_brain_founder_review_attempts_g6_item_fk foreign key (user_id, review_item_id)
    references public.company_brain_founder_review_items_g6(user_id, id) on delete restrict
);

create index company_brain_founder_review_items_g6_lookup_idx
  on public.company_brain_founder_review_items_g6 (user_id, category, item_type, review_key);
create index company_brain_founder_review_revisions_g6_lineage_idx
  on public.company_brain_founder_review_revisions_g6 (user_id, review_item_id, revision, supersedes_revision_id);

alter table public.company_brain_founder_review_items_g6 enable row level security;
alter table public.company_brain_founder_review_revisions_g6 enable row level security;
alter table public.company_brain_founder_review_evidence_g6 enable row level security;
alter table public.company_brain_founder_review_attempts_g6 enable row level security;

create policy company_brain_founder_review_items_g6_owner_read
  on public.company_brain_founder_review_items_g6 for select to authenticated
  using ((select auth.uid()) = user_id);
create policy company_brain_founder_review_revisions_g6_owner_read
  on public.company_brain_founder_review_revisions_g6 for select to authenticated
  using ((select auth.uid()) = user_id);
create policy company_brain_founder_review_evidence_g6_owner_read
  on public.company_brain_founder_review_evidence_g6 for select to authenticated
  using ((select auth.uid()) = user_id);
create policy company_brain_founder_review_attempts_g6_owner_read
  on public.company_brain_founder_review_attempts_g6 for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.company_brain_founder_review_items_g6,
  public.company_brain_founder_review_revisions_g6,
  public.company_brain_founder_review_evidence_g6,
  public.company_brain_founder_review_attempts_g6
  from public, anon, authenticated;

grant select on public.company_brain_founder_review_items_g6,
  public.company_brain_founder_review_revisions_g6,
  public.company_brain_founder_review_evidence_g6,
  public.company_brain_founder_review_attempts_g6
  to authenticated;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Records exactly one founder review decision. Tenant and actor are derived
-- from the authenticated session, never from the request body. The call fails
-- closed on a stale revision or a changed subject rather than overwriting
-- newer truth, and it can create no authority of any kind.
create or replace function public.record_company_brain_founder_review_g6(
  p_review_key text,
  p_category text,
  p_item_type text,
  p_subject_type text,
  p_subject_id text,
  p_scope_level text,
  p_review_scope jsonb,
  p_client_id uuid,
  p_conflict_id uuid,
  p_operating_model_id uuid,
  p_authority_proposal_id uuid,
  p_authority_grant_id uuid,
  p_review_action text,
  p_expected_revision integer,
  p_subject_fingerprint text,
  p_proposed_value jsonb,
  p_reviewed_value jsonb,
  p_reason text,
  p_evidence jsonb,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_item_id uuid;
  v_revision_id uuid := gen_random_uuid();
  v_actual_revision integer;
  v_predecessor_id uuid;
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_request_fingerprint text;
  v_status text;
  v_stored_item_type text;
begin
  if v_user_id is null then raise exception 'COMPANY_BRAIN_FOUNDER_REVIEW_AUTH_REQUIRED'; end if;
  if p_review_key is null or p_review_key !~ '^review-[0-9a-f]{32}$'
    or p_idempotency_key is null or btrim(p_idempotency_key) = ''
    or p_subject_fingerprint is null or p_subject_fingerprint !~ '^[0-9a-f]{64}$'
    or p_review_action not in ('APPROVE','EDIT','REJECT','HOLD','DEFER')
    or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(coalesce(p_review_scope, '{}'::jsonb)) <> 'object' then
    raise exception 'COMPANY_BRAIN_FOUNDER_REVIEW_MALFORMED';
  end if;
  if (p_review_action = 'EDIT' and p_reviewed_value is null)
    or (p_review_action <> 'EDIT' and p_reviewed_value is not null) then
    raise exception 'COMPANY_BRAIN_FOUNDER_REVIEW_VALUE_MALFORMED';
  end if;
  -- A conflict is decided through the G3 founder-decision path, and current
  -- authority is mutated through the G5 path. Neither is reviewable here.
  if p_item_type in ('CONFLICT','AUTHORITY_STATE') and p_review_action in ('APPROVE','EDIT','REJECT') then
    raise exception 'COMPANY_BRAIN_FOUNDER_REVIEW_ACTION_UNAVAILABLE';
  end if;
  if p_item_type = 'AUTHORITY_PROPOSAL' and p_review_action = 'APPROVE' then
    raise exception 'COMPANY_BRAIN_FOUNDER_REVIEW_ACTION_UNAVAILABLE';
  end if;

  v_status := case p_review_action
    when 'APPROVE' then 'APPROVED' when 'EDIT' then 'EDITED' when 'REJECT' then 'REJECTED'
    when 'HOLD' then 'HELD' else 'DEFERRED' end;

  v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'reviewKey', p_review_key, 'action', p_review_action,
    'expectedRevision', p_expected_revision, 'subjectFingerprint', p_subject_fingerprint,
    'reviewedValue', p_reviewed_value, 'reason', p_reason
  )::text, 'utf8')), 'hex');

  select id, request_fingerprint into v_existing_id, v_existing_fingerprint
  from public.company_brain_founder_review_revisions_g6
  where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if v_existing_id is not null then
    if v_existing_fingerprint <> v_request_fingerprint then
      insert into public.company_brain_founder_review_attempts_g6
        (user_id, actor_id, idempotency_key, request_fingerprint, outcome, revision_id)
      values (v_user_id, v_user_id, p_idempotency_key, v_request_fingerprint,
        'REJECTED_IDEMPOTENCY_CONFLICT', v_existing_id);
      return jsonb_build_object('outcome', 'REJECTED_IDEMPOTENCY_CONFLICT', 'revision_id', v_existing_id);
    end if;
    insert into public.company_brain_founder_review_attempts_g6
      (user_id, actor_id, idempotency_key, request_fingerprint, outcome, revision_id)
    values (v_user_id, v_user_id, p_idempotency_key, v_request_fingerprint, 'IDEMPOTENT_REPLAY', v_existing_id);
    return jsonb_build_object('outcome', 'IDEMPOTENT_REPLAY', 'revision_id', v_existing_id);
  end if;

  insert into public.company_brain_founder_review_items_g6 (
    user_id, review_key, category, item_type, subject_type, subject_id,
    scope_level, review_scope, client_id, conflict_id, operating_model_id,
    authority_proposal_id, authority_grant_id
  ) values (
    v_user_id, p_review_key, p_category, p_item_type, p_subject_type, p_subject_id,
    p_scope_level, coalesce(p_review_scope, '{}'::jsonb), p_client_id, p_conflict_id,
    p_operating_model_id, p_authority_proposal_id, p_authority_grant_id
  )
  on conflict (user_id, review_key) do update set updated_at = now()
  returning id, item_type into v_item_id, v_stored_item_type;

  -- Re-check the action against the item type ALREADY STORED for this review
  -- key, not the one the caller claimed: a caller must not be able to
  -- reclassify a conflict or an authority item into an approvable one.
  if v_stored_item_type in ('CONFLICT','AUTHORITY_STATE') and p_review_action in ('APPROVE','EDIT','REJECT') then
    raise exception 'COMPANY_BRAIN_FOUNDER_REVIEW_ACTION_UNAVAILABLE';
  end if;
  if v_stored_item_type = 'AUTHORITY_PROPOSAL' and p_review_action = 'APPROVE' then
    raise exception 'COMPANY_BRAIN_FOUNDER_REVIEW_ACTION_UNAVAILABLE';
  end if;

  select count(*) into v_actual_revision
  from public.company_brain_founder_review_revisions_g6
  where user_id = v_user_id and review_item_id = v_item_id;

  if p_expected_revision <> v_actual_revision then
    insert into public.company_brain_founder_review_attempts_g6
      (user_id, actor_id, review_item_id, idempotency_key, request_fingerprint,
       outcome, expected_revision, actual_revision)
    values (v_user_id, v_user_id, v_item_id, p_idempotency_key, v_request_fingerprint,
      'REJECTED_STALE_REVISION', p_expected_revision, v_actual_revision);
    raise exception 'COMPANY_BRAIN_FOUNDER_REVIEW_STALE_REVISION';
  end if;

  select id into v_predecessor_id
  from public.company_brain_founder_review_revisions_g6
  where user_id = v_user_id and review_item_id = v_item_id
  order by revision desc limit 1
  for update;

  insert into public.company_brain_founder_review_revisions_g6 (
    id, user_id, review_item_id, actor_id, actor_role, revision, review_action,
    review_status, subject_fingerprint, proposed_value, reviewed_value, reason,
    idempotency_key, request_fingerprint, supersedes_revision_id
  ) values (
    v_revision_id, v_user_id, v_item_id, v_user_id, 'FOUNDER', v_actual_revision + 1,
    p_review_action, v_status, p_subject_fingerprint, p_proposed_value, p_reviewed_value,
    p_reason, p_idempotency_key, v_request_fingerprint, v_predecessor_id
  );

  insert into public.company_brain_founder_review_evidence_g6
    (user_id, revision_id, claim_id, source_version_id)
  select v_user_id, v_revision_id, item.claim_id, item.source_version_id
  from jsonb_to_recordset(coalesce(p_evidence, '[]'::jsonb))
    as item(claim_id uuid, source_version_id uuid)
  where exists (
    select 1 from public.company_brain_claim_roots root
    where root.user_id = v_user_id and root.claim_id = item.claim_id
      and root.source_version_id = item.source_version_id
  );

  insert into public.company_brain_founder_review_attempts_g6
    (user_id, actor_id, review_item_id, idempotency_key, request_fingerprint,
     outcome, expected_revision, actual_revision, revision_id)
  values (v_user_id, v_user_id, v_item_id, p_idempotency_key, v_request_fingerprint,
    'ACCEPTED', p_expected_revision, v_actual_revision, v_revision_id);

  return jsonb_build_object(
    'outcome', 'ACCEPTED',
    'revision_id', v_revision_id,
    'review_item_id', v_item_id,
    'revision', v_actual_revision + 1,
    'authority_granted', false
  );
end;
$$;

revoke all on function public.record_company_brain_founder_review_g6(
  text,text,text,text,text,text,jsonb,uuid,uuid,uuid,uuid,uuid,text,integer,text,jsonb,jsonb,text,jsonb,text
) from public, anon, authenticated;
grant execute on function public.record_company_brain_founder_review_g6(
  text,text,text,text,text,text,jsonb,uuid,uuid,uuid,uuid,uuid,text,integer,text,jsonb,jsonb,text,jsonb,text
) to authenticated;
