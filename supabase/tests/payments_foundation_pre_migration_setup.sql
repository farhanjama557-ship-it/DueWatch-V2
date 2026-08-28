-- Disposable fixtures inserted after all earlier migrations and immediately
-- before 20260816120000_payments_foundation.sql.
insert into auth.users(id, email) values
  ('a2000000-0000-4000-8000-000000000001', 'payments-legacy-a@example.test'),
  ('b2000000-0000-4000-8000-000000000002', 'payments-legacy-b@example.test');

insert into public.clients(id, user_id, name) values
  ('a2100000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Legacy A'),
  ('b2100000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', 'Legacy B');

insert into public.invoices(
  id, user_id, client_id, inv_num, amount, amount_paid, paid, currency, payment_date
) values
  ('a2200000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000001', 'LEGACY-EVENT', 100, 100, true, 'USD', null),
  ('a2200000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000001', 'LEGACY-AMBIGUOUS', 100, 50, false, 'USD', null),
  ('a2200000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000001', 'LEGACY-KNOWN-DATE', 80, 80, true, 'EUR', '2026-01-05'),
  ('a2200000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000001', 'LEGACY-UNKNOWN-CURRENCY', 40, 25, false, null, null),
  ('b2200000-0000-4000-8000-000000000005', 'b2000000-0000-4000-8000-000000000002', 'b2100000-0000-4000-8000-000000000002', 'LEGACY-INCONSISTENT', 100, 50, true, 'USD', null),
  -- Historical DueWatch allowed positive payments beyond remaining balance.
  -- This fixture has exact amount-bearing event support for the 125 aggregate.
  ('a2200000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000001', 'LEGACY-OVERPAY-EVENT', 100, 125, true, 'USD', null),
  -- Pre-2026-07-24 payment_recorded events did not necessarily persist
  -- evidence.amount. Preserve the aggregate without inventing per-payment facts.
  ('a2200000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000001', 'LEGACY-OVERPAY-PRE-EVIDENCE', 80, 110, true, 'USD', null);

insert into public.events(id, user_id, event_type, invoice_id, created_at, evidence) values
  ('a2300000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'payment_recorded', 'a2200000-0000-4000-8000-000000000001', '2026-01-02 12:00:00+00', '{"amount":"40.00"}'),
  ('a2300000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'payment_recorded', 'a2200000-0000-4000-8000-000000000002', '2026-01-03 12:00:00+00', '{"amount":"40.00"}'),
  ('a2300000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'payment_recorded', 'a2200000-0000-4000-8000-000000000002', '2026-01-04 12:00:00+00', '{"amount":"40.00"}'),
  ('a2300000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'payment_recorded', 'a2200000-0000-4000-8000-000000000006', '2026-07-25 12:00:00+00', '{"amount":"50.00"}'),
  ('a2300000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000001', 'payment_recorded', 'a2200000-0000-4000-8000-000000000006', '2026-07-26 12:00:00+00', '{"amount":"75.00"}'),
  -- Two real legacy event identities, but no amount evidence: migration must
  -- not invent a 55/55 split (or any other split).
  ('a2300000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-000000000001', 'payment_recorded', 'a2200000-0000-4000-8000-000000000007', '2026-07-22 12:00:00+00', '{}'),
  ('a2300000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-000000000001', 'payment_recorded', 'a2200000-0000-4000-8000-000000000007', '2026-07-23 12:00:00+00', '{}');
