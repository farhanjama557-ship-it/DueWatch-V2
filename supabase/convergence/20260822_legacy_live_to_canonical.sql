-- ============================================================================
-- DueWatch — ONE-TIME legacy-live → canonical convergence script.
--
-- THIS IS NOT A MIGRATION. It must never live in supabase/migrations/ and
-- must never be executed by Supabase migration tooling on a fresh
-- environment. Fresh environments are constructed exclusively by
-- supabase/migrations/20260822000000_canonical_baseline.sql via db reset /
-- db push. This script exists solely to move the VERIFIED legacy
-- production baseline to exactly that canonical state.
--
-- Input state contract (verified against production 2026-08-22):
--   public tables: profiles, clients, invoices, line_items, reminders,
--   events, awaiting_signature, autopilot_runs, autopilot_settings,
--   autopilot_rules — and NOTHING ELSE from the post-baseline era.
--   invoices.client_id carries the legacy single-column FK to clients(id)
--   ON DELETE CASCADE; awaiting_signature carries the legacy
--   unique(user_id, invoice_id, status).
--
-- Classification (fail closed):
--   * verified legacy state            → converge
--   * anything else — including an already-converged database —
--                                      → RAISE before changing anything
--
-- How it converges: the canonical baseline itself is included verbatim
-- (\ir). Its statements are deterministic on the legacy state: additive
-- objects are created if missing, the legacy single-column client FK is
-- replaced by the composite tenant FK, and the legacy three-column
-- awaiting_signature uniqueness is replaced by the pending-only partial
-- unique index. The baseline's own internal preflights (cross-tenant
-- data checks, fail-closed catalog assertions) protect every transition.
--
-- Transactionality: the included baseline opens exactly one explicit
-- transaction (begin; ... commit;) spanning the entire convergence.
-- Execute with psql and ON_ERROR_STOP (see the production runbook):
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
--     -f supabase/convergence/20260822_legacy_live_to_canonical.sql
-- A failure anywhere inside the baseline transaction rolls the whole
-- convergence back; the preflight below runs before any change is made.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PHASE 0 — preflight classification. No mutation happens in this phase.
--
-- ONE-TIME TOOL CONTRACT (adversarial-review hardened):
--
--   VERIFIED LEGACY STATE            -> converge (PHASE 1)
--   ANY POST-BASELINE / ALREADY-
--   MUTATED STATE (including an
--   already-converged database)      -> REFUSE, require investigation
--
-- There is deliberately NO "already canonical -> no-op" shortcut: proving
-- full canonical structural equivalence here would mean duplicating the
-- entire canonical fingerprint, and a name-based sample check would
-- silently bless drifted FKs, indexes, columns, function bodies, grants,
-- triggers, or policies. A second invocation after a successful
-- convergence fails closed below WITHOUT changing anything — acceptable
-- and safer than a weak idempotency classification.
--
-- Classification is enforced by a FULL verified-legacy structural
-- fingerprint (see below): exact public-schema inventory, columns,
-- constraints, indexes, policies, RLS flags, and function definitions,
-- compared line-by-line against the verified legacy shape. Any extra
-- object (e.g. public.unexpected_drift) or any drift inside a recognized
-- object (column, index, policy, constraint definition) refuses BEFORE
-- any mutation. Only the exact supported legacy state may proceed.
--
-- All final canonical success assertions live INSIDE the baseline's
-- mutation transaction (sections/20260822000002_final_canonical_
-- assertions.sql, inlined immediately before its commit), so a failed
-- assertion rolls the entire convergence back. PHASE 2 of this script is
-- informational post-commit verification only.
-- ---------------------------------------------------------------------------

-- Post-baseline-era schema present at all -> refuse before any mutation.
-- (The structural fingerprint below independently rejects every
-- post-baseline-era public object; this check exists to give that
-- specific, common case its own unmistakable message.)
do $preflight_refuse_mutated$
begin
  if exists (select 1 from pg_namespace where nspname = 'duewatch_ops') then
    raise exception 'unknown/already-mutated state: schema duewatch_ops exists. This one-time convergence tool accepts ONLY the verified legacy baseline; a re-run after successful convergence is expected to fail closed here without changing anything. Investigate manually (or restore from the pre-convergence backup).';
  end if;
end
$preflight_refuse_mutated$;

-- ---------------------------------------------------------------------------
-- VERIFIED-LEGACY STRUCTURAL FINGERPRINT.
--
-- The ten-table existence check this replaced could be satisfied by ANY
-- database that merely contained those ten names alongside arbitrary
-- unknown objects (e.g. public.unexpected_drift) or subtle drift inside a
-- recognized object. That is not "verified legacy only".
--
-- Instead the preflight renders the COMPLETE normalized structure and
-- security state of the public schema — every relation of every kind,
-- every column, every constraint, every index, every policy, every RLS
-- flag, every function, every non-internal trigger on the application
-- tables, object ownership (normalized role names), and the explicit
-- security-relevant privilege state (table/column/function ACLs for
-- PUBLIC, anon, authenticated, service_role, catalog-faithful via
-- aclexplode) — and requires exact equality with the verified legacy
-- shape (the archived schema.sql lineage plus the two live-verified
-- drifts: the invoices client FK ON DELETE CASCADE and the legacy
-- three-column awaiting_signature uniqueness, plus the live-verified
-- autopilot tables).
--
-- Equality is required on object names, types, definitions, nullability,
-- defaults, constraint validity/deferrability, index definitions (via
-- pg_get_indexdef, which embeds uniqueness, key columns and predicates),
-- policy commands/roles/expressions, full function definitions
-- (pg_get_functiondef), trigger enabled-state and definitions
-- (pg_get_triggerdef), owners (role NAMES, never OIDs), and the exact
-- explicit ACL entries above. NOT compared: catalog OIDs, physical
-- ordering, grantors, and the auth/extensions/platform schemas (platform
-- territory, not DueWatch application structure — the one DueWatch-owned
-- platform trigger, on_auth_user_created on auth.users, is asserted
-- separately and exactly below).
--
-- An unexpected trigger, a removed/changed/disabled expected trigger, a
-- non-trusted owner (anything other than the platform 'postgres' role),
-- or any unexpected security-relevant grant on a legacy application
-- object refuses BEFORE any mutation. (The Autopilot tables' ACLs are
-- the one intentional exception: they are deterministically
-- canonicalized in the baseline with exact postcondition assertion;
-- their LEGACY input state is still fingerprinted here.)
--
-- On mismatch the ACTUAL rendering is emitted line-by-line as NOTICEs and
-- the exception reports the first differing line, so any refusal is fully
-- diagnosable in the run log.
-- ---------------------------------------------------------------------------
do $preflight_legacy_fingerprint$
declare
  v_expected text := $fp$

COLUMN|autopilot_rules.created_at|timestamp with time zone|true|now()
COLUMN|autopilot_rules.enabled|boolean|true|true
COLUMN|autopilot_rules.id|uuid|true|gen_random_uuid()
COLUMN|autopilot_rules.name|text|true|-
COLUMN|autopilot_rules.sort_order|integer|true|0
COLUMN|autopilot_rules.tone|text|true|'friendly'::text
COLUMN|autopilot_rules.trigger_days|integer|true|-
COLUMN|autopilot_rules.trigger_type|text|true|-
COLUMN|autopilot_rules.user_id|uuid|true|-
COLUMN|autopilot_runs.completed_at|timestamp with time zone|false|-
COLUMN|autopilot_runs.errors|integer|true|0
COLUMN|autopilot_runs.id|uuid|true|gen_random_uuid()
COLUMN|autopilot_runs.invoices_checked|integer|true|0
COLUMN|autopilot_runs.reminders_drafted|integer|true|0
COLUMN|autopilot_runs.reminders_skipped|integer|true|0
COLUMN|autopilot_runs.started_at|timestamp with time zone|true|now()
COLUMN|autopilot_runs.status|text|true|'running'::text
COLUMN|autopilot_runs.user_id|uuid|true|-
COLUMN|autopilot_settings.approval_required|boolean|true|true
COLUMN|autopilot_settings.created_at|timestamp with time zone|true|now()
COLUMN|autopilot_settings.enabled|boolean|true|false
COLUMN|autopilot_settings.id|uuid|true|gen_random_uuid()
COLUMN|autopilot_settings.updated_at|timestamp with time zone|true|now()
COLUMN|autopilot_settings.user_id|uuid|true|-
COLUMN|awaiting_signature.action_type|text|true|'send_reminder'::text
COLUMN|awaiting_signature.ai_context|jsonb|false|'{}'::jsonb
COLUMN|awaiting_signature.ai_reason|text|true|-
COLUMN|awaiting_signature.created_at|timestamp with time zone|true|now()
COLUMN|awaiting_signature.draft_content|text|true|-
COLUMN|awaiting_signature.founder_note|text|false|-
COLUMN|awaiting_signature.id|uuid|true|gen_random_uuid()
COLUMN|awaiting_signature.invoice_id|uuid|true|-
COLUMN|awaiting_signature.recommended_tone|text|true|-
COLUMN|awaiting_signature.resolved_at|timestamp with time zone|false|-
COLUMN|awaiting_signature.status|text|true|'pending'::text
COLUMN|awaiting_signature.user_id|uuid|true|-
COLUMN|clients.company|text|false|-
COLUMN|clients.created_at|timestamp with time zone|true|now()
COLUMN|clients.email|text|false|-
COLUMN|clients.id|uuid|true|gen_random_uuid()
COLUMN|clients.name|text|true|-
COLUMN|clients.notes|text|false|-
COLUMN|clients.phone|text|false|-
COLUMN|clients.user_id|uuid|true|-
COLUMN|events.created_at|timestamp with time zone|true|now()
COLUMN|events.event_type|text|true|-
COLUMN|events.evidence|jsonb|false|'{}'::jsonb
COLUMN|events.id|uuid|true|gen_random_uuid()
COLUMN|events.invoice_id|uuid|false|-
COLUMN|events.lifecycle_stage|text|false|-
COLUMN|events.lifecycle_state|text|false|-
COLUMN|events.previous_action_id|uuid|false|-
COLUMN|events.user_id|uuid|true|-
COLUMN|invoices.amount_paid|numeric(12,2)|true|0
COLUMN|invoices.amount|numeric(12,2)|true|0
COLUMN|invoices.autopilot_paused|boolean|true|false
COLUMN|invoices.client_id|uuid|false|-
COLUMN|invoices.created_at|timestamp with time zone|true|now()
COLUMN|invoices.due_date|date|false|-
COLUMN|invoices.id|uuid|true|gen_random_uuid()
COLUMN|invoices.inv_date|date|false|-
COLUMN|invoices.inv_num|text|false|-
COLUMN|invoices.last_reminder|timestamp with time zone|false|-
COLUMN|invoices.notes|text|false|-
COLUMN|invoices.paid|boolean|true|false
COLUMN|invoices.user_id|uuid|true|-
COLUMN|line_items.created_at|timestamp with time zone|true|now()
COLUMN|line_items.description|text|true|-
COLUMN|line_items.id|uuid|true|gen_random_uuid()
COLUMN|line_items.invoice_id|uuid|true|-
COLUMN|line_items.quantity|numeric(12,2)|true|1
COLUMN|line_items.unit_price|numeric(12,2)|true|0
COLUMN|line_items.user_id|uuid|true|-
COLUMN|profiles.created_at|timestamp with time zone|true|now()
COLUMN|profiles.email|text|false|-
COLUMN|profiles.full_name|text|false|-
COLUMN|profiles.id|uuid|true|-
COLUMN|profiles.last_seen_at|timestamp with time zone|false|-
COLUMN|reminders.created_at|timestamp with time zone|true|now()
COLUMN|reminders.detail|text|false|-
COLUMN|reminders.id|uuid|true|gen_random_uuid()
COLUMN|reminders.invoice_id|uuid|true|-
COLUMN|reminders.title|text|true|-
COLUMN|reminders.user_id|uuid|true|-
CONSTRAINT|autopilot_rules.autopilot_rules_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|autopilot_rules.autopilot_rules_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|autopilot_runs.autopilot_runs_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|autopilot_runs.autopilot_runs_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|autopilot_settings.autopilot_settings_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|autopilot_settings.autopilot_settings_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|autopilot_settings.autopilot_settings_user_id_key|u|UNIQUE (user_id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|awaiting_signature.awaiting_signature_invoice_id_fkey|f|FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|awaiting_signature.awaiting_signature_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|awaiting_signature.awaiting_signature_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|awaiting_signature.awaiting_signature_user_id_invoice_id_status_key|u|UNIQUE (user_id, invoice_id, status)|validated=true|deferrable=false|deferred=false
CONSTRAINT|clients.clients_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|clients.clients_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|events.events_invoice_id_fkey|f|FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL|validated=true|deferrable=false|deferred=false
CONSTRAINT|events.events_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|events.events_previous_action_id_fkey|f|FOREIGN KEY (previous_action_id) REFERENCES events(id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|events.events_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|invoices.invoices_client_id_fkey|f|FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|invoices.invoices_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|invoices.invoices_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|line_items.line_items_invoice_id_fkey|f|FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|line_items.line_items_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|line_items.line_items_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|profiles.profiles_id_fkey|f|FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|profiles.profiles_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|reminders.reminders_invoice_id_fkey|f|FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
CONSTRAINT|reminders.reminders_pkey|p|PRIMARY KEY (id)|validated=true|deferrable=false|deferred=false
CONSTRAINT|reminders.reminders_user_id_fkey|f|FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE|validated=true|deferrable=false|deferred=false
FUNCTION|handle_new_user()|CREATE OR REPLACE FUNCTION public.handle_new_user()\n RETURNS trigger\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public'\nAS $function$\nbegin\n  insert into public.profiles (id, email, full_name)\n  values (\n    new.id,\n    new.email,\n    coalesce(new.raw_user_meta_data ->> 'full_name', '')\n  )\n  on conflict (id) do nothing;\n  return new;\nend;\n$function$\n
INDEX|autopilot_rules.autopilot_rules_pkey|CREATE UNIQUE INDEX autopilot_rules_pkey ON public.autopilot_rules USING btree (id)
INDEX|autopilot_runs.autopilot_runs_pkey|CREATE UNIQUE INDEX autopilot_runs_pkey ON public.autopilot_runs USING btree (id)
INDEX|autopilot_runs.autopilot_runs_user_idx|CREATE INDEX autopilot_runs_user_idx ON public.autopilot_runs USING btree (user_id, started_at DESC)
INDEX|autopilot_settings.autopilot_settings_pkey|CREATE UNIQUE INDEX autopilot_settings_pkey ON public.autopilot_settings USING btree (id)
INDEX|autopilot_settings.autopilot_settings_user_id_key|CREATE UNIQUE INDEX autopilot_settings_user_id_key ON public.autopilot_settings USING btree (user_id)
INDEX|awaiting_signature.awaiting_signature_created_idx|CREATE INDEX awaiting_signature_created_idx ON public.awaiting_signature USING btree (created_at DESC)
INDEX|awaiting_signature.awaiting_signature_pkey|CREATE UNIQUE INDEX awaiting_signature_pkey ON public.awaiting_signature USING btree (id)
INDEX|awaiting_signature.awaiting_signature_user_id_invoice_id_status_key|CREATE UNIQUE INDEX awaiting_signature_user_id_invoice_id_status_key ON public.awaiting_signature USING btree (user_id, invoice_id, status)
INDEX|awaiting_signature.awaiting_signature_user_status_idx|CREATE INDEX awaiting_signature_user_status_idx ON public.awaiting_signature USING btree (user_id, status)
INDEX|clients.clients_pkey|CREATE UNIQUE INDEX clients_pkey ON public.clients USING btree (id)
INDEX|clients.clients_user_id_idx|CREATE INDEX clients_user_id_idx ON public.clients USING btree (user_id)
INDEX|events.events_lifecycle_idx|CREATE INDEX events_lifecycle_idx ON public.events USING btree (lifecycle_stage, lifecycle_state)
INDEX|events.events_pkey|CREATE UNIQUE INDEX events_pkey ON public.events USING btree (id)
INDEX|events.events_type_idx|CREATE INDEX events_type_idx ON public.events USING btree (event_type)
INDEX|events.events_user_id_idx|CREATE INDEX events_user_id_idx ON public.events USING btree (user_id)
INDEX|invoices.invoices_client_id_idx|CREATE INDEX invoices_client_id_idx ON public.invoices USING btree (client_id)
INDEX|invoices.invoices_pkey|CREATE UNIQUE INDEX invoices_pkey ON public.invoices USING btree (id)
INDEX|invoices.invoices_user_id_idx|CREATE INDEX invoices_user_id_idx ON public.invoices USING btree (user_id)
INDEX|line_items.line_items_invoice_id_idx|CREATE INDEX line_items_invoice_id_idx ON public.line_items USING btree (invoice_id)
INDEX|line_items.line_items_pkey|CREATE UNIQUE INDEX line_items_pkey ON public.line_items USING btree (id)
INDEX|line_items.line_items_user_id_idx|CREATE INDEX line_items_user_id_idx ON public.line_items USING btree (user_id)
INDEX|profiles.profiles_pkey|CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id)
INDEX|reminders.reminders_invoice_id_idx|CREATE INDEX reminders_invoice_id_idx ON public.reminders USING btree (invoice_id)
INDEX|reminders.reminders_pkey|CREATE UNIQUE INDEX reminders_pkey ON public.reminders USING btree (id)
INDEX|reminders.reminders_user_id_idx|CREATE INDEX reminders_user_id_idx ON public.reminders USING btree (user_id)
OWNER_FUNCTION|handle_new_user()|postgres
OWNER_TABLE|autopilot_rules|postgres
OWNER_TABLE|autopilot_runs|postgres
OWNER_TABLE|autopilot_settings|postgres
OWNER_TABLE|awaiting_signature|postgres
OWNER_TABLE|clients|postgres
OWNER_TABLE|events|postgres
OWNER_TABLE|invoices|postgres
OWNER_TABLE|line_items|postgres
OWNER_TABLE|profiles|postgres
OWNER_TABLE|reminders|postgres
POLICY|autopilot_rules.autopilot_rules_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
POLICY|autopilot_runs.autopilot_runs_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
POLICY|autopilot_settings.autopilot_settings_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
POLICY|awaiting_signature.awaiting_signature_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
POLICY|clients.clients_all_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
POLICY|events.events_all_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
POLICY|invoices.invoices_all_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
POLICY|line_items.line_items_all_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
POLICY|profiles.profiles_insert_own|INSERT|roles=public|permissive=PERMISSIVE|qual=-|withcheck=(auth.uid() = id)
POLICY|profiles.profiles_select_own|SELECT|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = id)|withcheck=-
POLICY|profiles.profiles_update_own|UPDATE|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = id)|withcheck=(auth.uid() = id)
POLICY|reminders.reminders_all_own|ALL|roles=public|permissive=PERMISSIVE|qual=(auth.uid() = user_id)|withcheck=(auth.uid() = user_id)
RELATION|autopilot_rules|r
RELATION|autopilot_runs|r
RELATION|autopilot_settings|r
RELATION|awaiting_signature|r
RELATION|clients|r
RELATION|events|r
RELATION|invoices|r
RELATION|line_items|r
RELATION|profiles|r
RELATION|reminders|r
TABLE_GRANT|autopilot_rules|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|autopilot_rules|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|autopilot_rules|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|autopilot_rules|privilege=REFERENCES,grantee=anon
TABLE_GRANT|autopilot_rules|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|autopilot_rules|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|autopilot_rules|privilege=TRIGGER,grantee=anon
TABLE_GRANT|autopilot_rules|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|autopilot_rules|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|autopilot_rules|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|autopilot_rules|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|autopilot_rules|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|autopilot_runs|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|autopilot_runs|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|autopilot_runs|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|autopilot_runs|privilege=REFERENCES,grantee=anon
TABLE_GRANT|autopilot_runs|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|autopilot_runs|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|autopilot_runs|privilege=TRIGGER,grantee=anon
TABLE_GRANT|autopilot_runs|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|autopilot_runs|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|autopilot_runs|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|autopilot_runs|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|autopilot_runs|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|autopilot_settings|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|autopilot_settings|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|autopilot_settings|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|autopilot_settings|privilege=REFERENCES,grantee=anon
TABLE_GRANT|autopilot_settings|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|autopilot_settings|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|autopilot_settings|privilege=TRIGGER,grantee=anon
TABLE_GRANT|autopilot_settings|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|autopilot_settings|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|autopilot_settings|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|autopilot_settings|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|autopilot_settings|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|awaiting_signature|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|awaiting_signature|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|awaiting_signature|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|awaiting_signature|privilege=REFERENCES,grantee=anon
TABLE_GRANT|awaiting_signature|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|awaiting_signature|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|awaiting_signature|privilege=TRIGGER,grantee=anon
TABLE_GRANT|awaiting_signature|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|awaiting_signature|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|awaiting_signature|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|awaiting_signature|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|awaiting_signature|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|clients|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|clients|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|clients|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|clients|privilege=REFERENCES,grantee=anon
TABLE_GRANT|clients|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|clients|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|clients|privilege=TRIGGER,grantee=anon
TABLE_GRANT|clients|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|clients|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|clients|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|clients|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|clients|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|events|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|events|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|events|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|events|privilege=REFERENCES,grantee=anon
TABLE_GRANT|events|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|events|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|events|privilege=TRIGGER,grantee=anon
TABLE_GRANT|events|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|events|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|events|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|events|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|events|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|invoices|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|invoices|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|invoices|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|invoices|privilege=REFERENCES,grantee=anon
TABLE_GRANT|invoices|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|invoices|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|invoices|privilege=TRIGGER,grantee=anon
TABLE_GRANT|invoices|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|invoices|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|invoices|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|invoices|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|invoices|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|line_items|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|line_items|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|line_items|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|line_items|privilege=REFERENCES,grantee=anon
TABLE_GRANT|line_items|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|line_items|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|line_items|privilege=TRIGGER,grantee=anon
TABLE_GRANT|line_items|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|line_items|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|line_items|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|line_items|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|line_items|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|profiles|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|profiles|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|profiles|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|profiles|privilege=REFERENCES,grantee=anon
TABLE_GRANT|profiles|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|profiles|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|profiles|privilege=TRIGGER,grantee=anon
TABLE_GRANT|profiles|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|profiles|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|profiles|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|profiles|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|profiles|privilege=TRUNCATE,grantee=service_role
TABLE_GRANT|reminders|privilege=MAINTAIN,grantee=anon
TABLE_GRANT|reminders|privilege=MAINTAIN,grantee=authenticated
TABLE_GRANT|reminders|privilege=MAINTAIN,grantee=service_role
TABLE_GRANT|reminders|privilege=REFERENCES,grantee=anon
TABLE_GRANT|reminders|privilege=REFERENCES,grantee=authenticated
TABLE_GRANT|reminders|privilege=REFERENCES,grantee=service_role
TABLE_GRANT|reminders|privilege=TRIGGER,grantee=anon
TABLE_GRANT|reminders|privilege=TRIGGER,grantee=authenticated
TABLE_GRANT|reminders|privilege=TRIGGER,grantee=service_role
TABLE_GRANT|reminders|privilege=TRUNCATE,grantee=anon
TABLE_GRANT|reminders|privilege=TRUNCATE,grantee=authenticated
TABLE_GRANT|reminders|privilege=TRUNCATE,grantee=service_role
TABLE_RLS|autopilot_rules|rls=true,force=false
TABLE_RLS|autopilot_runs|rls=true,force=false
TABLE_RLS|autopilot_settings|rls=true,force=false
TABLE_RLS|awaiting_signature|rls=true,force=false
TABLE_RLS|clients|rls=true,force=false
TABLE_RLS|events|rls=true,force=false
TABLE_RLS|invoices|rls=true,force=false
TABLE_RLS|line_items|rls=true,force=false
TABLE_RLS|profiles|rls=true,force=false
TABLE_RLS|reminders|rls=true,force=false

$fp$;
  v_actual text;
  v_exp text[];
  v_act text[];
  v_i int;
  v_j int;
begin
  -- Normalize away stray leading/trailing newlines so only the fingerprint
  -- CONTENT is compared.
  v_expected := btrim(v_expected, chr(10));
  select string_agg(line, chr(10) order by line) into v_actual
  from (
    -- Exact inventory of EVERY public relation of every relkind: the ten
    -- verified legacy tables and nothing else — no views, matviews,
    -- sequences, or foreign tables, no unknown extra tables.
    select 'RELATION|' || c.relname || '|' || c.relkind::text as line
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m','S','f')
    union all
    select 'TABLE_RLS|' || c.relname
         || '|rls=' || c.relrowsecurity || ',force=' || c.relforcerowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
    union all
    select 'COLUMN|' || c.relname || '.' || a.attname
         || '|' || format_type(a.atttypid, a.atttypmod)
         || '|' || a.attnotnull
         || '|' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), '-')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where n.nspname = 'public' and c.relkind in ('r','p')
    union all
    select 'CONSTRAINT|' || c.relname || '.' || con.conname
         || '|' || con.contype::text
         || '|' || pg_get_constraintdef(con.oid)
         || '|validated=' || con.convalidated
         || '|deferrable=' || con.condeferrable
         || '|deferred=' || con.condeferred
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    union all
    select 'INDEX|' || t.relname || '.' || i.relname
         || '|' || pg_get_indexdef(i.oid)
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
    union all
    select 'POLICY|' || pol.tablename || '.' || pol.policyname
         || '|' || pol.cmd
         || '|roles=' || array_to_string(pol.roles, ',')
         || '|permissive=' || pol.permissive
         || '|qual=' || coalesce(replace(pol.qual, chr(10), '\n'), '-')
         || '|withcheck=' || coalesce(replace(pol.with_check, chr(10), '\n'), '-')
    from pg_policies pol
    where pol.schemaname = 'public'
    union all
    select 'FUNCTION|' || p.proname
         || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         || '|' || replace(pg_get_functiondef(p.oid), chr(10), '\n')
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
    union all
    -- Non-internal triggers on the application tables: name, enabled
    -- state, full definition. An unexpected trigger, a missing expected
    -- one, a changed target/function/timing/event, or a disabled/enabled
    -- drift is a fingerprint mismatch.
    select 'TRIGGER|' || c.relname || '.' || t.tgname
         || '|enabled=' || (t.tgenabled = 'O')
         || '|def=' || pg_get_triggerdef(t.oid)
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    union all
    -- Ownership of application objects by normalized role NAME (never
    -- OID). anon/authenticated/service_role or any unknown custom role
    -- owning a DueWatch application table/function is a mismatch.
    select 'OWNER_TABLE|' || c.relname || '|' || r.rolname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
    where n.nspname = 'public' and c.relkind in ('r','p')
    union all
    select 'OWNER_FUNCTION|' || p.proname
         || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || r.rolname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public' and p.prokind = 'f'
    union all
    -- Explicit security-relevant table privileges (catalog-faithful
    -- aclexplode of relacl — explicit entries only, no acldefault
    -- expansion; grantors are irrelevant). PUBLIC is grantee OID 0.
    select 'TABLE_GRANT|' || c.relname
         || '|privilege=' || a.privilege_type
         || ',grantee=' || case a.grantee when 0 then 'PUBLIC' else r.rolname end
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
         aclexplode(c.relacl) as a(grantor, grantee, privilege_type, is_grantable)
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and c.relkind in ('r','p')
      and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
    union all
    -- Explicit column-level privileges (attacl), same grantees.
    select 'COLUMN_GRANT|' || c.relname || '.' || g.attname
         || '|privilege=' || a.privilege_type
         || ',grantee=' || case a.grantee when 0 then 'PUBLIC' else r.rolname end
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute g on g.attrelid = c.oid and g.attnum > 0 and not g.attisdropped
         and g.attacl is not null
    cross join lateral aclexplode(g.attacl) as a(grantor, grantee, privilege_type, is_grantable)
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and c.relkind in ('r','p')
      and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
    union all
    -- Explicit function EXECUTE privileges (proacl), same grantees.
    select 'FUNCTION_GRANT|' || p.proname
         || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         || '|privilege=' || a.privilege_type
         || ',grantee=' || case a.grantee when 0 then 'PUBLIC' else r.rolname end
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace,
         aclexplode(p.proacl) as a(grantor, grantee, privilege_type, is_grantable)
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and p.prokind = 'f'
      and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'))
  ) all_lines;

  if v_actual is distinct from v_expected then
    v_exp := string_to_array(v_expected, chr(10));
    v_act := string_to_array(coalesce(v_actual, '<NULL>'), chr(10));
    for v_i in 1 .. greatest(array_length(v_exp, 1), array_length(v_act, 1)) loop
      if coalesce(v_exp[v_i], '<absent>') <> coalesce(v_act[v_i], '<absent>') then
        raise notice 'convergence preflight: actual fingerprint rendering follows';
        for v_j in 1 .. array_length(v_act, 1) loop
          raise notice 'FP-ACTUAL: %', v_act[v_j];
        end loop;
        raise exception using
          errcode = '22023',
          message = 'unknown/drifted state: the database does not match the VERIFIED legacy baseline fingerprint; refusing before any mutation',
          detail = 'first differing fingerprint line #' || v_i || ':'
            || chr(10) || 'expected: ' || coalesce(v_exp[v_i], '<absent>')
            || chr(10) || 'actual:   ' || coalesce(v_act[v_i], '<absent>')
            || chr(10) || '(expected ' || array_length(v_exp, 1) || ' lines, actual '
            || array_length(v_act, 1) || ' lines; full actual rendering emitted as FP-ACTUAL notices above)';
      end if;
    end loop;
    raise exception 'unknown/drifted state: fingerprint mismatch detected but no differing line found (length difference only)';
  end if;

  raise notice 'convergence preflight: verified legacy baseline fingerprint matched exactly (inventory, columns, constraints, indexes, policies, RLS, functions, triggers, ownership, ACLs)';
end
$preflight_legacy_fingerprint$;

-- ---------------------------------------------------------------------------
-- DUEWATCH-OWNED PLATFORM TRIGGER — exact separate assertion.
--
-- schema.sql installs exactly one DueWatch-owned trigger on a platform
-- table: on_auth_user_created on auth.users, calling
-- public.handle_new_user(). It is part of the verified legacy state and
-- must exist, be ENABLED, and match its exact definition. Arbitrary
-- Supabase platform triggers on auth.users are NOT fingerprinted; any
-- OTHER trigger on auth.users whose function lives in public (i.e.
-- DueWatch-owned code) is an unexpected drift and refuses.
-- ---------------------------------------------------------------------------
do $preflight_auth_users_trigger$
declare
  v_def text;
  v_enabled boolean;
begin
  select pg_get_triggerdef(t.oid), t.tgenabled = 'O'
    into v_def, v_enabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'auth' and c.relname = 'users'
    and not t.tgisinternal
    and t.tgname = 'on_auth_user_created';
  if v_def is null then
    raise exception 'unknown state: the expected DueWatch-owned trigger on_auth_user_created on auth.users is missing; this is not the verified legacy baseline';
  end if;
  if not v_enabled then
    raise exception 'drifted state: the DueWatch-owned trigger on_auth_user_created on auth.users is DISABLED (expected enabled); refusing before any mutation';
  end if;
  if v_def <> 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()' then
    raise exception 'drifted state: the on_auth_user_created trigger on auth.users does not match its exact canonical definition; actual: %', v_def;
  end if;
  if exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc f on f.oid = t.tgfoid
    join pg_namespace fn on fn.oid = f.pronamespace
    where n.nspname = 'auth' and c.relname = 'users'
      and not t.tgisinternal
      and fn.nspname = 'public'
      and t.tgname <> 'on_auth_user_created'
  ) then
    raise exception 'unknown state: an unexpected DueWatch-owned (public-function) trigger exists on auth.users in addition to on_auth_user_created; refusing before any mutation';
  end if;
  raise notice 'convergence preflight: DueWatch-owned auth.users trigger on_auth_user_created verified (present, enabled, exact definition)';
end
$preflight_auth_users_trigger$;

-- ---------------------------------------------------------------------------
-- PHASE 1 — the canonical baseline, verbatim. On the legacy state this
-- creates every missing canonical object and performs the two documented
-- state transitions (invoice/client composite tenant FK; pending-only
-- awaiting_signature uniqueness). Its own internal preflights and
-- assertions fail closed on anything it does not recognize.
-- ---------------------------------------------------------------------------
\ir ../migrations/20260822000000_canonical_baseline.sql

-- ---------------------------------------------------------------------------
-- PHASE 2 — informational post-commit checks. These duplicate a subset of
-- the FINAL canonical assertions that already executed INSIDE the
-- baseline transaction (before its commit); they are a human-visible
-- confirmation only and are NOT rollback-protected success gates. The
-- rollback-protected contract lives in the baseline itself.
-- ---------------------------------------------------------------------------
do $postconditions$
declare
  v_definition text;
begin
  select pg_get_constraintdef(oid) into v_definition
  from pg_constraint
  where conrelid = 'public.invoices'::regclass
    and conname = 'invoices_user_id_client_id_fkey'
    and contype = 'f';
  if v_definition is null
    or v_definition not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_definition not like '%ON DELETE SET NULL (client_id)%' then
    raise exception 'postcondition failed: invoice/client composite tenant FK is not canonical';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.awaiting_signature'::regclass
      and conname = 'awaiting_signature_user_id_invoice_id_status_key'
  ) then
    raise exception 'postcondition failed: legacy awaiting_signature three-column unique constraint still present';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'awaiting_signature'
      and indexname = 'awaiting_signature_one_pending_per_invoice'
  ) then
    raise exception 'postcondition failed: pending-only awaiting_signature unique index missing';
  end if;

  if to_regclass('public.autopilot_execution_claims') is null
     or to_regclass('public.payments') is null
     or to_regclass('public.payment_allocations') is null
     or to_regclass('public.import_runs') is null
     or to_regclass('public.client_source_identities') is null then
    raise exception 'postcondition failed: canonical era tables missing after convergence';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'acquire_autopilot_execution_claim'
  ) or not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_payment'
  ) then
    raise exception 'postcondition failed: canonical RPCs missing after convergence';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payments'
      and policyname = 'payments_select_own'
  ) and exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'autopilot_settings'
      and policyname = 'autopilot_settings_own'
  ) then
    raise notice 'convergence postconditions: all canonical checks passed';
  else
    raise exception 'postcondition failed: canonical policies missing after convergence';
  end if;
end
$postconditions$;
