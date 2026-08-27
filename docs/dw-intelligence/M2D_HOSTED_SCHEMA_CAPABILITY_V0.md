# Ask DW M2D — Hosted Schema / Capability Catch-up v0

Status: implementation candidate for M2D.

## Goal

Make hosted DueWatch structure match the capabilities the repository actually declares,
then prove that match from schema-only deployment evidence.

M2D does not infer business authority from deployment structure and does not read tenant
financial rows to build its proof.

## Proof-system hardening

M2D makes the System Brain dependency audit recognize literal Supabase dependencies,
unambiguous file-local constant aliases used by table/RPC calls, and authenticated
Supabase Edge Function calls. Dynamic or ambiguous identifiers are deliberately not
guessed.

Ask DW's browser model transport is closed-world to `ask-dw-model`; callers cannot
redirect it to an arbitrary Edge Function.

Compatibility treats a required Edge Function as structurally unavailable when it is
missing, not ACTIVE, or deployed without JWT verification when the code contract
requires it. A structural match never grants business or execution authority.

## Hosted migration rule

Do not blindly replay repository migrations against production merely because hosted
migration history is absent or incomplete. First fingerprint the live schema, then
reconcile exact missing structures and apply reviewed migrations in dependency order.

Production verification is catalog/schema only. No tenant invoice, client, payment,
email, evidence, or conversation rows are selected for M2D proof.

## M2C persistence acceptance

The hosted project must eventually prove `public.ask_dw_conversations`, owner-scoped
RLS, read-only direct browser table access, the guarded authenticated persistence RPC,
optimistic stale-write rejection, immutable TTL/creation anchors, and the durable
no-financial/no-execution-authority boundary.

## Model capability acceptance

The hosted project must prove `ask-dw-model` is present, ACTIVE, and JWT-verified before
founder-facing live model activation can claim the capability exists. Provider secrets
and account allowlists remain server-side and fail closed.

## Completion gate

M2D is complete only after proof-system regressions pass, pre-catch-up compatibility
truthfully exposes hosted drift, reviewed hosted changes are applied through a trusted
administrative channel, a post-catch-up schema-only fingerprint is captured, required
Ask DW dependencies are MATCH, the full test suite/build/diff gates pass, and the PR is
merged with post-merge `main` verified.

## Hosted catch-up execution plan (candidate)

Production currently has a legacy hosted baseline that predates the repository's
canonical-client/import/payment/DW Intelligence/M2C structures. Historical replay is
therefore preceded by `20260827191000_m2d_hosted_baseline_reconciliation.sql`.

That reconciliation is deliberately non-semantic: it adds nullable client compatibility
fields without guessing values, removes the legacy same-name uniqueness constraint,
makes `invoices.client_id` and `invoices.due_date` nullable to match current runtime
semantics, and widens legacy `last_reminder` DATE values to midnight-UTC timestamps.

After that precondition is proven, M2D may replay only the hash-locked authoritative
migration list exposed by `scripts/system-brain/m2d-hosted-catchup-plan.mjs`, in that
exact order.

`20260825003000_dw_intelligence_live_transitions_phase2b.sql` is explicitly excluded:
its own header identifies it as a local proof artifact and says not to apply it to a
paid/cloud environment.

The Ask DW Edge Function deployment is separately closed-world to `ask-dw-model`, with
JWT verification required. Presence/ACTIVE/JWT are structural capability only; model
enablement, account allowlisting, provider configuration, and founder activation remain
fail-closed and are not inferred from deployment structure.
