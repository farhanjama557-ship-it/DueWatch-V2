-- Provider webhook replay guard.
-- PostgreSQL UNIQUE treats NULL as distinct, so unattributed/quarantined
-- events need an explicit partial unique index to absorb retries too.

begin;

create unique index if not exists provider_webhook_events_unattributed_event_uniq
  on public.provider_webhook_events(provider, provider_event_id)
  where connection_id is null;

commit;
