-- ============================================================
-- Duewatch — demo data seed
-- Run manually in the Supabase SQL Editor. Not run by Claude Code.
--
-- 8 clients, 18 invoices (6 paid / 4 overdue / 3 critical / 2 final
-- notice / 2 due soon / 1 further out), amounts $680–$8,000, dates
-- spread across the last ~90 days.
--
-- Idempotent: every insert is guarded by NOT EXISTS on a natural key
-- (client name, invoice number, or invoice+event_type), so re-running
-- this script after it's already applied inserts nothing new.
--
-- IMPORTANT: replace the email below if it isn't your Duewatch login.
-- Everything is scoped to this one auth.users row via that lookup —
-- nothing here touches RLS policies or any other account. If the email
-- doesn't match any row, every insert below silently affects 0 rows
-- (no error) — run this first to confirm it resolves before proceeding:
--
--   select id, email from auth.users where email = 'farhanjama557@gmail.com';
-- ============================================================

-- ---------- 1. Clients ----------
insert into public.clients (user_id, name, email, phone, company)
select u.id, v.name, v.email, v.phone, v.company
from (select id from auth.users where email = 'farhanjama557@gmail.com') u
cross join (values
  ('Meridian Design Co',        'accounts@meridiandesign.co',   '555-0101', 'Meridian Design Co'),
  ('Northfield Logistics',      'ap@northfieldlogistics.com',   '555-0102', 'Northfield Logistics'),
  ('Cedar & Vine Interiors',    'billing@cedarandvine.com',     '555-0103', 'Cedar & Vine Interiors'),
  ('Bluewave Analytics',        'finance@bluewaveanalytics.io', '555-0104', 'Bluewave Analytics'),
  ('Harbor Point Consulting',   'ap@harborpointconsulting.com', '555-0105', 'Harbor Point Consulting'),
  ('Silverline Media Group',    'accounts@silverlinemedia.com', '555-0106', 'Silverline Media Group'),
  ('Ashford Legal Partners',    'billing@ashfordlegal.com',     '555-0107', 'Ashford Legal Partners'),
  ('Terra Nova Studio',         'hello@terranovastudio.com',    '555-0108', 'Terra Nova Studio')
) as v(name, email, phone, company)
where not exists (
  select 1 from public.clients c
  where c.user_id = u.id and c.name = v.name
);

-- ---------- 2. Invoices ----------
-- due_date/inv_date are computed relative to current_date so they stay
-- realistic (last ~90 days) no matter when this script actually runs.
insert into public.invoices (user_id, client_id, inv_num, amount, amount_paid, inv_date, due_date, paid, last_reminder)
select u.id, c.id, v.inv_num, v.amount, v.amount_paid,
       current_date + v.inv_offset, current_date + v.due_offset,
       v.paid,
       case when v.reminder_offset is null then null
            else now() + (v.reminder_offset::text || ' days')::interval end
from (select id from auth.users where email = 'farhanjama557@gmail.com') u
join (values
  -- client_name,                 inv_num,    amount,  amount_paid, inv_offset, due_offset, paid,  reminder_offset
  -- Paid (6)
  ('Meridian Design Co',        'INV-D101', 4200.00, 4200.00, -60, -30, true,  null),
  ('Northfield Logistics',      'INV-D102', 1850.00, 1850.00, -50, -20, true,  null),
  ('Cedar & Vine Interiors',    'INV-D103', 6400.00, 6400.00, -40, -10, true,  null),
  ('Bluewave Analytics',        'INV-D104',  950.00,  950.00, -35,  -5, true,  null),
  ('Harbor Point Consulting',   'INV-D105', 3100.00, 3100.00, -25,  -1, true,  null),
  ('Silverline Media Group',    'INV-D106', 2600.00, 2600.00, -15,  10, true,  null),
  -- Overdue, 1-14 days (4)
  ('Harbor Point Consulting',   'INV-D201', 1200.00,    0.00, -20,  -5, false, -2),
  ('Terra Nova Studio',         'INV-D202', 2750.00,    0.00, -18,  -3, false, -1),
  ('Ashford Legal Partners',    'INV-D203', 5400.00,    0.00, -25, -10, false, null),
  ('Bluewave Analytics',        'INV-D204',  680.00,    0.00, -15,  -1, false, null),
  -- Critical, 15-30 days overdue (3)
  ('Meridian Design Co',        'INV-D301', 3900.00,    0.00, -45, -22, false, -4),
  ('Cedar & Vine Interiors',    'INV-D302', 1500.00,    0.00, -50, -28, false, null),
  ('Silverline Media Group',    'INV-D303', 7200.00,    0.00, -55, -18, false, -6),
  -- Final notice, 30+ days overdue (2)
  ('Northfield Logistics',      'INV-D401', 8000.00,    0.00, -80, -40, false, -10),
  ('Ashford Legal Partners',    'INV-D402', 2300.00,    0.00, -70, -35, false, null),
  -- Due soon, within 14 days (2)
  ('Terra Nova Studio',         'INV-D501', 1600.00,    0.00, -10,   6, false, null),
  ('Harbor Point Consulting',   'INV-D502', 4500.00,    0.00,  -5,  12, false, null),
  -- Further out, >14 days away (1)
  ('Bluewave Analytics',        'INV-D601', 2100.00,    0.00,  -2,  25, false, null)
) as v(client_name, inv_num, amount, amount_paid, inv_offset, due_offset, paid, reminder_offset)
  on true
join public.clients c on c.user_id = u.id and c.name = v.client_name
where not exists (
  select 1 from public.invoices i
  where i.user_id = u.id and i.inv_num = v.inv_num
);

-- ---------- 3. Payment events ----------
-- "Collected this month" (and the KPI's month-over-month trend) is read
-- entirely from events.evidence.amount, never from invoices.paid — so the
-- 6 paid invoices above need matching events or Collected will still show
-- $0. Four are dated within the last 2 weeks (this month, in most runs)
-- and two are dated 35-40 days back (last month, for the trend line) —
-- exact month-boundary alignment depends on the day you actually run this.
insert into public.events (user_id, event_type, invoice_id, evidence, created_at)
select u.id, 'invoice_marked_paid', i.id,
       jsonb_build_object('amount', v.amount, 'reason', 'Demo seed data'),
       now() + (v.paid_offset::text || ' days')::interval
from (select id from auth.users where email = 'farhanjama557@gmail.com') u
join (values
  ('INV-D101', 4200.00,  -3),
  ('INV-D102', 1850.00,  -6),
  ('INV-D103', 6400.00,  -9),
  ('INV-D104',  950.00, -13),
  ('INV-D105', 3100.00, -35),
  ('INV-D106', 2600.00,  -2)
) as v(inv_num, amount, paid_offset)
  on true
join public.invoices i on i.user_id = u.id and i.inv_num = v.inv_num
where not exists (
  select 1 from public.events e
  where e.user_id = u.id and e.invoice_id = i.id and e.event_type = 'invoice_marked_paid'
);

-- ============================================================
-- Optional verification query — read-only, safe to run separately.
-- ============================================================
-- select
--   count(*) filter (where paid) as paid_invoices,
--   count(*) filter (where not paid) as outstanding_invoices,
--   sum(amount - amount_paid) filter (where not paid) as outstanding_total
-- from public.invoices i
-- join auth.users u on u.id = i.user_id
-- where u.email = 'farhanjama557@gmail.com';
--
-- select sum((evidence->>'amount')::numeric) as collected_this_month
-- from public.events e
-- join auth.users u on u.id = e.user_id
-- where u.email = 'farhanjama557@gmail.com'
--   and e.event_type in ('payment_recorded', 'invoice_marked_paid')
--   and e.created_at >= date_trunc('month', now());
