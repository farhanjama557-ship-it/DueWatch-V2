-- ============================================================
-- DueWatch — demo seed data
-- Four clients with distinct payment personalities, so the app tells a
-- story from the first login. Run in the Supabase SQL editor.
--
-- BEFORE RUNNING: replace the placeholder user id below with your own.
--   While logged into the app, run:  select auth.uid();
--   ...or copy your id from Authentication → Users.
-- Then paste it into the `uid` line and run this whole file.
--
-- To remove all of this later, run cleanup_demo.sql.
-- ============================================================

do $$
declare
  uid uuid := '00000000-0000-0000-0000-000000000000'; -- <<< REPLACE with your auth user id
  c_atlas  uuid;
  c_north  uuid;
  c_beacon uuid;
  c_marlow uuid;
  i_beacon uuid;
begin
  -- ---- Clients ----
  insert into public.clients (user_id, name) values (uid, 'Atlas Creative')   returning id into c_atlas;
  insert into public.clients (user_id, name) values (uid, 'Northfield Co')     returning id into c_north;
  insert into public.clients (user_id, name) values (uid, 'Beacon Studio')     returning id into c_beacon;
  insert into public.clients (user_id, name) values (uid, 'Marlow & Partners') returning id into c_marlow;

  -- ---- Atlas Creative — always pays early, healthy relationship ----
  insert into public.invoices (user_id, client_id, inv_num, amount, amount_paid, inv_date, due_date, paid, notes)
    values (uid, c_atlas, 'INV-ATL-001', 2500, 2500, current_date - 40, current_date - 10, true,
            'Paid early, as always.');
  insert into public.invoices (user_id, client_id, inv_num, amount, amount_paid, inv_date, due_date, paid, notes)
    values (uid, c_atlas, 'INV-ATL-002', 1800, 0, current_date - 20, current_date + 10, false,
            'Sent — due in 10 days.');

  -- ---- Northfield Co — consistently ~7 days late; currently 9 days overdue ----
  insert into public.invoices (user_id, client_id, inv_num, amount, amount_paid, inv_date, due_date, paid, notes)
    values (uid, c_north, 'INV-NOR-001', 3200, 0, current_date - 39, current_date - 9, false,
            'Usually pays about a week late.');

  -- ---- Beacon Studio — ignores the first nudge, needs a firm tone; 22 days overdue ----
  insert into public.invoices (user_id, client_id, inv_num, amount, amount_paid, inv_date, due_date, paid, last_reminder, notes)
    values (uid, c_beacon, 'INV-BEA-001', 5800, 0, current_date - 52, current_date - 22, false,
            (current_date - 5)::timestamptz, 'Two reminders sent, no response yet.')
    returning id into i_beacon;
  insert into public.reminders (invoice_id, user_id, title, detail, created_at) values
    (i_beacon, uid, 'First reminder sent', 'Friendly reminder emailed.',            (current_date - 12)::timestamptz),
    (i_beacon, uid, 'Firm reminder sent',  'Second reminder emailed, firmer tone.', (current_date - 5)::timestamptz);

  -- ---- Marlow & Partners — large balance, partial payment, Final Notice tier; 35 days overdue ----
  insert into public.invoices (user_id, client_id, inv_num, amount, amount_paid, inv_date, due_date, paid, last_reminder, notes)
    values (uid, c_marlow, 'INV-MAR-001', 12000, 3000, current_date - 65, current_date - 35, false,
            (current_date - 3)::timestamptz, '$3,000 paid, $9,000 outstanding. Final notice.');
end $$;
