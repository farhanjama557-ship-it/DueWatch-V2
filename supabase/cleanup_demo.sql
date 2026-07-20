-- ============================================================
-- DueWatch — remove demo seed data (see seed_demo.sql)
-- Run in the Supabase SQL editor.
--
-- BEFORE RUNNING: set `uid` to the SAME user id you seeded with.
-- Deletes only the four demo clients and everything hanging off them.
-- ============================================================

do $$
declare
  uid uuid := '00000000-0000-0000-0000-000000000000'; -- <<< REPLACE with the user id used in seed_demo.sql
  demo_names text[] := array['Atlas Creative', 'Northfield Co', 'Beacon Studio', 'Marlow & Partners'];
begin
  -- reminders for the demo invoices
  delete from public.reminders r
   using public.invoices i, public.clients c
   where r.invoice_id = i.id and i.client_id = c.id
     and c.user_id = uid and c.name = any(demo_names);

  -- usage events for the demo invoices (only if the events table exists)
  if to_regclass('public.events') is not null then
    delete from public.events e
     using public.invoices i, public.clients c
     where e.invoice_id = i.id and i.client_id = c.id
       and c.user_id = uid and c.name = any(demo_names);
  end if;

  -- line items for the demo invoices (in case any were added)
  delete from public.line_items li
   using public.invoices i, public.clients c
   where li.invoice_id = i.id and i.client_id = c.id
     and c.user_id = uid and c.name = any(demo_names);

  -- the demo invoices
  delete from public.invoices i
   using public.clients c
   where i.client_id = c.id and c.user_id = uid and c.name = any(demo_names);

  -- the demo clients
  delete from public.clients where user_id = uid and name = any(demo_names);
end $$;
