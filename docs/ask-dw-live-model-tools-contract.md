# Ask DW Phase 2E — Live Model Provider + Tenant-Scoped Reads

## Goal

Phase 2E connects the Phase 2D governed orchestration boundary to two real external seams without weakening its authority model:

1. an authenticated Supabase Edge Function that calls the OpenAI Responses API with strict Structured Outputs; and
2. real Duewatch read tools backed by the existing tenant-scoped Supabase tables.

No model or read tool receives a write primitive.

## Live invoice flow

`authenticated invoice question → fresh Duewatch invoice/policy/evidence read → deterministic DW truth core → OpenAI PLAN → allow-listed Supabase reads → OpenAI SYNTHESIZE → fresh OpenAI VERIFY → Phase 2D truth lock → answer`

## Security, privacy, and accounting boundaries

- `OPENAI_API_KEY` exists only in the Supabase Edge Function environment. It is never a Vite/browser environment variable.
- The Edge Function verifies the caller JWT before any paid model request.
- Paid model execution is gated by `ASK_DW_MODEL_ENABLED=true` and is disabled by default.
- Even when the global gate is enabled, callers are denied unless their user ID is in `ASK_DW_MODEL_ALLOWED_USER_IDS`, unless `ASK_DW_MODEL_ALLOW_ALL_AUTHENTICATED=true` is deliberately enabled.
- Provider requests have a bounded timeout and API responses are returned with `Cache-Control: no-store`.
- Every live read tool verifies the authenticated user and requires `tenantId === auth.user.id`.
- Tenant-owned tables are explicitly filtered by `user_id` where the schema provides it, with RLS as defense in depth.
- Requested tool scope (`INVOICE`, `CLIENT`, or `PORTFOLIO`) is passed explicitly to handlers. Carrying invoice/client context does not silently collapse a broader requested scope back to invoice scope.
- Client email is not included in Phase 2E model-facing canonical reads, and payment note text is not included in the payment-reconciliation tool. This increment sends only the fields needed for current AR reasoning.
- `payments` and `payment_allocations` are read only; existing hardened RPCs remain the only payment mutation route.
- Canonical payment reconciliation fails closed if the current bounded allocation window would be incomplete.
- Load-bearing deterministic evidence and memory reads fail closed rather than silently truncating. Inferential precedent/activity windows explicitly report when they are bounded or incomplete.
- Tombstones are loaded against the exact memory IDs admitted into the current read window, preventing an arbitrary newest-N tombstone window from accidentally missing a revocation for loaded memory.
- No send/email, mark-paid, apply-cash, credit, write-off, or legal action tool is registered.
- The model cannot modify the Phase 2D truth lock or execution authority.
- Raw chain-of-thought is neither requested nor returned.

## Current live scope

The first live truth-locked entry point is deliberately **invoice-scoped**. The current deterministic Phase 2B/DW core itself is invoice-scoped, so Phase 2E does not pretend a portfolio question can be governed by wrapping one arbitrary invoice.

Client and portfolio **read tools** are available for broader context during an invoice investigation. A true business-wide truth core is a later increment.

## Real read sources used

- `invoices`
- `clients`
- `payments`
- `payment_allocations`
- `events`
- `autopilot_rules`
- `autopilot_settings`
- `awaiting_signature`
- `autopilot_execution_claims`
- `dw_evidence_items`
- `dw_memory_claims`
- `dw_memory_evidence_links`
- `dw_memory_tombstones`
- `dw_tombstone_evidence_links`
- `dw_proof_events`

The current repo does not define a dedicated canonical dispute table. `dispute_context` therefore returns attributed evidence, admitted memory, and persisted DW proof state with an explicit limitation instead of inventing canonical dispute truth.

The `dw_*` read sources must actually exist in the target Supabase environment. This adapter intentionally fails closed on missing/load-bearing schema instead of treating a missing migration as an empty evidence or memory set.

## Model configuration

The Edge Function uses:

- `OPENAI_API_KEY` — required, server-side only
- `OPENAI_PRIMARY_MODEL` — optional, defaults to `gpt-5.6-sol`
- `OPENAI_VERIFIER_MODEL` — optional, defaults to `gpt-5.6-sol`
- `ASK_DW_MODEL_ENABLED` — must equal `true` before any provider call is permitted
- `ASK_DW_MODEL_ALLOWED_USER_IDS` — comma-separated authenticated user IDs allowed to use the live model when broad access is not enabled
- `ASK_DW_MODEL_ALLOW_ALL_AUTHENTICATED` — optional explicit broad-access override; default is not enabled

The provider uses the Responses API with `store: false` and strict `text.format` JSON Schema outputs. Model IDs remain environment-configurable so evaluation can compare quality/cost without changing the governed orchestration contract.

## What this increment still does not do

- It does not deploy the Edge Function.
- It does not apply hosted Supabase migrations.
- It does not set any provider secret or enable any user.
- It does not make a paid OpenAI request during installation or tests.
- It does not add production write/action tools.
- It does not create a dedicated dispute or Promise-to-Pay canonical schema.
- It does not create a business-wide deterministic truth core yet.
- It does not add durable application-level rate limiting or budget accounting; broad live access must remain off until those controls and provider/project spend limits are separately configured.
- It does not claim production readiness until hosted migrations, RLS, Edge Function configuration, live privacy review, and adversarial evals are separately verified.
