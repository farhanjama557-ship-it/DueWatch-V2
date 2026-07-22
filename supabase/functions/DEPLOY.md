# Deploying the Autopilot Edge Functions

This sandbox has no `supabase` CLI and no network path to Supabase, so these
functions are written but not deployed. Run these steps yourself.

## 1. One-time setup

```bash
# from the repo root, with the Supabase CLI installed and logged in
supabase link --project-ref <your-project-ref>
```

`RESEND_API_KEY` should already be set as an Edge Function secret (confirmed).
Verify it's visible to functions:

```bash
supabase secrets list
```

## 2. Deploy both functions

```bash
supabase functions deploy send-reminder-email
supabase functions deploy autopilot-scheduler
```

`send-reminder-email` is called by the app (Approve & Send, Edit First, and
the manual Send Reminder button) — it requires a valid user session and
verifies the invoice belongs to the caller before sending anything.

`autopilot-scheduler` is meant to run once a day (Quiet Mode — the only real
cadence built this session; Standard/Active/Always On are still UI-only
previews).

## 3. Schedule the daily run

Easiest: **Supabase Dashboard → Edge Functions → autopilot-scheduler → Cron**,
set it to once daily.

Or via SQL, if the `pg_cron` and `pg_net` extensions are enabled on the
project:

```sql
select cron.schedule(
  'autopilot-daily',
  '0 13 * * *',  -- adjust to your preferred UTC hour
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/autopilot-scheduler',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    )
  )
  $$
);
```

## 4. Required: verify a sending domain in Resend

`supabase/functions/_shared/resend.js` currently sends `from: 'Duewatch
<reminders@duewatch.app>'`. **Resend will reject this** until that domain is
verified in your Resend account (Resend dashboard → Domains → Add Domain →
add the DNS records they give you). Until it's verified, change the `from`
in `_shared/resend.js` to Resend's sandbox address (`onboarding@resend.dev`)
so you can test end-to-end, then switch to your real domain once verified.

## 5. One assumption to confirm

Both functions read the recipient address as `invoice.clients.email`. If
your `clients` table's real email column has a different name, update the
`.select(...)` calls in `send-reminder-email/index.js` and
`autopilot-scheduler/index.js` (two spots each) — everything else is
unaffected. If it errors, the error message will say exactly this
("column clients.email does not exist" or similar).

## 6. Smoke test

Once deployed:
1. Trigger `send-reminder-email` manually from the app: open an invoice with
   Autopilot rules pending (or use "Send reminder"). If it fails, the error
   from Resend (bad domain, bad key, etc.) shows directly in the panel.
2. Invoke `autopilot-scheduler` once by hand (`supabase functions invoke
   autopilot-scheduler` or a `curl` POST to its URL) before waiting for the
   cron — check the `autopilot_runs` table gets a new row with real counts.
