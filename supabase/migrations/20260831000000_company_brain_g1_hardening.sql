-- M2G-G1-HARDENING: four security gaps identified by independent audit.
--
-- Gap 1 – Founder-decision idempotency: same key + same payload = safe replay;
--          same key + changed payload = explicit rejection.
-- Gap 2 – Server-authoritative prior state: derive state from DB, not caller;
--          validate provenance references exist, belong to tenant, and are active.
-- Gap 3 – Revocation closure: root-source revocation immediately invalidates
--          dependent conflicts and marks referencing snapshots STALE.
-- Gap 4 – Semantic-reference integrity: JSONB provenance arrays validated
--          server-side before any decision is persisted.
--
-- All changes are additive to the G1 migration (20260830055532). No financial
-- ledger tables are touched. No existing RLS policies are narrowed.

-- ── Schema additions ─────────────────────────────────────────────────────────

-- Gap 1: store request fingerprint on every accepted decision for replay validation.
alter table public.company_brain_founder_decisions
  add column if not exists request_fingerprint text
    check (request_fingerprint ~ '^[0-9a-f]{64}$');

-- Gap 3: snapshots can become STALE after root-source revocation.
alter table public.company_brain_snapshots
  add column if not exists status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'STALE'));

-- ── Updated record_company_brain_founder_decision ────────────────────────────
-- Replaces the G1 version with all four gap fixes applied.
create or replace function public.record_company_brain_founder_decision(
  p_idempotency_key text,
  p_target_type      text,
  p_target_id        uuid,
  p_expected_revision integer,
  p_decision_type    text,
  p_prior_state      jsonb,
  p_new_state        jsonb,
  p_reason           text,
  p_provenance       jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id          uuid    := (select auth.uid());
  v_current_revision integer;
  v_server_status    text;
  v_existing         uuid;
  v_stored_fp        text;
  v_decision_id      uuid    := gen_random_uuid();
  v_supersedes       uuid;
  -- Deterministic fingerprint covering all material decision fields.
  -- Identical payload ⟹ identical fingerprint; any change ⟹ conflict.
  v_fingerprint text := encode(
    sha256(convert_to(
      concat_ws('|',
        p_target_type, p_target_id::text, p_expected_revision::text,
        p_decision_type, p_prior_state::text, p_new_state::text,
        p_reason, p_provenance::text),
      'utf8')),
    'hex');
begin
  if v_user_id is null then raise exception 'COMPANY_BRAIN_AUTH_REQUIRED'; end if;
  if p_target_type not in ('CONFLICT','AUTHORITY_PROPOSAL') or p_target_id is null then
    raise exception 'COMPANY_BRAIN_SCOPE_INVALID';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or p_reason is null or btrim(p_reason) = '' then
    raise exception 'COMPANY_BRAIN_DECISION_MALFORMED';
  end if;

  -- Gap 1: fingerprint-bound idempotency.
  -- Same key + same payload → safe replay.
  -- Same key + different payload → explicit conflict (not silent pass-through).
  select id into v_existing
    from public.company_brain_founder_decisions
    where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if v_existing is not null then
    select request_fingerprint into v_stored_fp
      from public.company_brain_founder_decisions
      where user_id = v_user_id and id = v_existing;
    if v_stored_fp is not null and v_stored_fp <> v_fingerprint then
      raise exception 'COMPANY_BRAIN_IDEMPOTENCY_KEY_CONFLICT';
    end if;
    return jsonb_build_object('outcome', 'IDEMPOTENT_REPLAY', 'decision_id', v_existing);
  end if;

  -- Gap 2: server-authoritative state — derive from DB, never trust caller alone.
  if p_target_type = 'CONFLICT' then
    select revision, status into v_current_revision, v_server_status
      from public.company_brain_conflicts
      where user_id = v_user_id and id = p_target_id for update;
  else
    select revision, status into v_current_revision, v_server_status
      from public.company_brain_authority_proposals
      where user_id = v_user_id and id = p_target_id and status <> 'REVOKED' for update;
  end if;
  if v_current_revision is null then raise exception 'COMPANY_BRAIN_TARGET_MISSING_OR_REVOKED'; end if;

  -- Gap 2: stale revision — log attempt and reject.
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

  -- Gap 2: prior-state cross-check — caller's claimed prior status must match server.
  -- A stale or fabricated prior_state is a safe rejection, not a silent pass-through.
  if (p_prior_state->>'status') is not null
     and (p_prior_state->>'status') <> v_server_status then
    insert into public.company_brain_founder_decision_attempts (
      user_id, actor_id, target_type, target_id, expected_revision,
      actual_revision, outcome, request_fingerprint
    ) values (
      v_user_id, v_user_id, p_target_type, p_target_id, p_expected_revision,
      v_current_revision, 'REJECTED_STALE', v_fingerprint
    );
    return jsonb_build_object(
      'outcome', 'REJECTED_PRIOR_STATE_MISMATCH',
      'claimed_status', p_prior_state->>'status',
      'server_status',  v_server_status
    );
  end if;

  -- Gap 2 + Gap 4: provenance reference integrity.
  -- If p_provenance is a JSON array, every element must be a real, active,
  -- same-tenant claim UUID. Dangling, cross-tenant, and revoked refs fail closed.
  if p_provenance is not null and jsonb_typeof(p_provenance) = 'array' then
    if exists (
      select 1 from jsonb_array_elements_text(p_provenance) as ref_id
      where not exists (
        select 1 from public.company_brain_claims
        where user_id = v_user_id
          and id::text = ref_id
          and active = true
      )
    ) then
      raise exception 'COMPANY_BRAIN_PROVENANCE_INVALID';
    end if;
  end if;

  select id into v_supersedes
    from public.company_brain_founder_decisions
    where user_id = v_user_id and target_type = p_target_type and target_id = p_target_id
    order by created_at desc limit 1;

  insert into public.company_brain_founder_decisions (
    id, user_id, actor_id, idempotency_key, decision_type, target_type,
    target_id, target_revision, prior_state, new_state, reason, provenance,
    supersedes_decision_id, request_fingerprint
  ) values (
    v_decision_id, v_user_id, v_user_id, p_idempotency_key, p_decision_type,
    p_target_type, p_target_id, p_expected_revision + 1, p_prior_state,
    p_new_state, p_reason, p_provenance, v_supersedes, v_fingerprint
  );

  if p_target_type = 'CONFLICT' then
    update public.company_brain_conflicts
      set status = 'RESOLVED', revision = revision + 1,
          resolution_decision_id = v_decision_id, updated_at = now()
      where user_id = v_user_id and id = p_target_id;
  else
    update public.company_brain_authority_proposals
      set status = coalesce(p_new_state->>'status', 'REJECTED'),
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

  return jsonb_build_object(
    'outcome', 'ACCEPTED',
    'decision_id', v_decision_id,
    'actual_revision', p_expected_revision + 1
  );
end;
$$;

-- ── Updated revoke_company_brain_source ──────────────────────────────────────
-- Replaces the G1 version with Gap 3 closure logic.
create or replace function public.revoke_company_brain_source(
  p_source_id uuid,
  p_reason    text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id     uuid := (select auth.uid());
  v_tombstone_id uuid := gen_random_uuid();
begin
  if v_user_id is null then raise exception 'COMPANY_BRAIN_AUTH_REQUIRED'; end if;
  if p_source_id is null or p_reason is null or btrim(p_reason) = '' then
    raise exception 'COMPANY_BRAIN_REVOCATION_MALFORMED';
  end if;

  update public.company_brain_sources
    set active = false, revoked_at = now(),
        revocation_reason = p_reason, updated_at = now()
    where user_id = v_user_id and id = p_source_id and active = true;

  if not found then
    select id into v_tombstone_id
      from public.company_brain_source_tombstones
      where user_id = v_user_id and source_id = p_source_id;
    if v_tombstone_id is null then raise exception 'COMPANY_BRAIN_SOURCE_MISSING'; end if;
    return v_tombstone_id;
  end if;

  -- Revoke all non-terminal source versions.
  update public.company_brain_source_versions
    set status = 'REVOKED'
    where user_id = v_user_id and source_id = p_source_id
      and status in ('PROCESSING', 'ACTIVE', 'SUPERSEDED');

  -- Deactivate artifacts derived from this source.
  update public.company_brain_artifacts a
    set active = false, updated_at = now()
    where a.user_id = v_user_id and exists (
      select 1 from public.company_brain_source_versions v
        where v.user_id = v_user_id and v.source_id = p_source_id
          and v.id = a.source_version_id
    );

  -- Invalidate claims rooted in this source.
  update public.company_brain_claims c
    set active = false, status = 'INVALIDATED', updated_at = now()
    where c.user_id = v_user_id and exists (
      select 1
        from public.company_brain_claim_roots r
          join public.company_brain_source_versions v
            on v.user_id = r.user_id and v.id = r.source_version_id
        where r.user_id = v_user_id and r.claim_id = c.id
          and v.source_id = p_source_id
    );

  -- Gap 3: revocation closure — invalidate conflicts whose every competing claim
  -- is now inactive. The conflict cannot remain CONFLICTED with no live evidence.
  update public.company_brain_conflicts c
    set status = 'INVALIDATED', updated_at = now()
    where c.user_id = v_user_id
      and c.status = 'CONFLICTED'
      and not exists (
        select 1
          from public.company_brain_conflict_members m
            join public.company_brain_claims cl
              on cl.user_id = m.user_id and cl.id = m.claim_id
          where m.user_id = v_user_id
            and m.conflict_id = c.id
            and cl.active = true
      );

  -- Gap 3: mark ACTIVE snapshots that reference any revoked source version as STALE
  -- so consumers cannot read invalidated knowledge from a previously-built snapshot.
  update public.company_brain_snapshots s
    set status = 'STALE'
    where s.user_id = v_user_id
      and s.status = 'ACTIVE'
      and exists (
        select 1
          from public.company_brain_source_versions v
          where v.user_id = v_user_id
            and v.source_id = p_source_id
            and s.source_version_ids ? v.id::text
      );

  insert into public.company_brain_source_tombstones (id, user_id, source_id, actor_id, reason)
    values (v_tombstone_id, v_user_id, p_source_id, v_user_id, p_reason);

  return v_tombstone_id;
end;
$$;

-- Grants are unchanged from G1; the updated functions inherit the same
-- revoke/grant pattern via CREATE OR REPLACE.
revoke execute on function public.record_company_brain_founder_decision(text,text,uuid,integer,text,jsonb,jsonb,text,jsonb) from public, anon;
revoke execute on function public.revoke_company_brain_source(uuid,text) from public, anon;
grant execute on function public.record_company_brain_founder_decision(text,text,uuid,integer,text,jsonb,jsonb,text,jsonb) to authenticated;
grant execute on function public.revoke_company_brain_source(uuid,text) to authenticated;
