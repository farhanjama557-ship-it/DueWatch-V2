-- replace_promise only mutates tenant-owned promise rows through existing
-- authenticated table privileges, RLS, and the SECURITY INVOKER validation
-- trigger. It does not need owner elevation.
begin;

alter function public.replace_promise(uuid, numeric, date, text, text)
  security invoker;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'replace_promise'
      and pg_get_function_identity_arguments(p.oid) = 'p_existing_id uuid, p_promised_amount numeric, p_promised_date date, p_source text, p_note text'
      and p.prosecdef
  ) then
    raise exception 'replace_promise must remain SECURITY INVOKER';
  end if;
end
$$;

commit;
