-- Provider phase 5: human-confirmed link boundary.
-- Deterministic matches may be recomputed by server reconciliation; ambiguous
-- candidates persist as proposals and only an authenticated tenant owner may
-- convert a proposal into a durable confirmed link.

begin;

create unique index if not exists provider_object_links_one_confirmed_entity
  on public.provider_object_links(user_id, provider_object_id, entity_type)
  where confirmed_at is not null;

create unique index if not exists provider_reconciliation_one_open_reason
  on public.provider_reconciliation_exceptions(user_id, provider_object_id, reason)
  where resolved_at is null and provider_object_id is not null;

drop function if exists public.confirm_provider_object_link(uuid);
create function public.confirm_provider_object_link(
  p_link_id uuid
) returns public.provider_object_links
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_link public.provider_object_links%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_link
  from public.provider_object_links
  where id = p_link_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'PROVIDER_LINK_NOT_FOUND' using errcode = '42501';
  end if;

  if v_link.confirmed_at is not null then
    return v_link;
  end if;

  if v_link.entity_type = 'invoice' then
    if not exists (
      select 1 from public.invoices
      where id = v_link.entity_id and user_id = v_user_id
    ) then
      raise exception 'PROVIDER_LINK_ENTITY_TENANT_MISMATCH';
    end if;
  elsif v_link.entity_type = 'client' then
    if not exists (
      select 1 from public.clients
      where id = v_link.entity_id and user_id = v_user_id
    ) then
      raise exception 'PROVIDER_LINK_ENTITY_TENANT_MISMATCH';
    end if;
  elsif v_link.entity_type = 'payment' then
    if not exists (
      select 1 from public.payments
      where id = v_link.entity_id and user_id = v_user_id
    ) then
      raise exception 'PROVIDER_LINK_ENTITY_TENANT_MISMATCH';
    end if;
  else
    raise exception 'PROVIDER_LINK_ENTITY_TYPE_NOT_CONFIRMABLE';
  end if;

  if exists (
    select 1
    from public.provider_object_links
    where user_id = v_user_id
      and provider_object_id = v_link.provider_object_id
      and entity_type = v_link.entity_type
      and confirmed_at is not null
      and id <> v_link.id
  ) then
    raise exception 'PROVIDER_LINK_ALREADY_CONFIRMED';
  end if;

  update public.provider_object_links
  set confirmed_by = v_user_id,
      confirmed_at = clock_timestamp(),
      match_basis = 'confirmed'
  where id = v_link.id
    and user_id = v_user_id
  returning * into v_link;

  delete from public.provider_object_links
  where user_id = v_user_id
    and provider_object_id = v_link.provider_object_id
    and entity_type = v_link.entity_type
    and id <> v_link.id
    and confirmed_at is null;

  update public.provider_reconciliation_exceptions
  set resolved_at = clock_timestamp(),
      resolved_by = v_user_id
  where user_id = v_user_id
    and provider_object_id = v_link.provider_object_id
    and resolved_at is null;

  return v_link;
end;
$$;

revoke all on function public.confirm_provider_object_link(uuid)
  from public, anon;
grant execute on function public.confirm_provider_object_link(uuid)
  to authenticated;

commit;
