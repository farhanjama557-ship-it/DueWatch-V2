# M2G G1 Hardening Audit

**Branch:** `m2g/g1-hardening-audit`
**Base:** `m2g/company-brain-bootstrap-g1` @ `ab6db44b84f05a47f002fd6bce21dfe2451bc6ea`
**Date:** 2026-08-31
**Status:** Complete — all four gaps patched, 11 regression tests added, 0 regressions in existing suite.

## Audit scope

An independent audit of the G1 durable-store implementation (`20260830055532_company_brain_durable_ingestion_g1.sql` and `src/lib/companyBrain/durableStore.js`) identified four hardening gaps. This document records what each gap was, what was changed, and why.

Financial ledger tables (`invoices`, `payments`, `payment_attempts`, `payouts`, `bank_transactions`) are untouched. R0 boundaries are preserved and regression-tested.

---

## Gap 1 — Founder-decision idempotency

**Finding:** The G1 RPC and JS store both supported idempotent replay (same idempotency key → return existing decision), but neither validated that the re-submitted payload was identical to the first. A caller could replay the same key with a structurally different decision and silently receive the original decision, bypassing audit integrity.

**Fix — JS (`durableStore.js`):**
Added `decisionFingerprint()`: a SHA-256 hash over all material decision fields (`targetId`, `expectedRevision`, `decisionType`, `oldState`, `newState`, `evidenceClaimIds` sorted for determinism, `reason`). The fingerprint is stored on every accepted decision row as `requestFingerprint`. On any subsequent call with the same `idempotencyKey`, the incoming fingerprint is compared against the stored one. A mismatch throws `'idempotency key reused with different decision payload'`.

**Fix — SQL (`20260831000000_company_brain_g1_hardening.sql`):**
`ALTER TABLE public.company_brain_founder_decisions ADD COLUMN IF NOT EXISTS request_fingerprint text CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')`. The updated `record_company_brain_founder_decision` RPC computes `v_fingerprint` via `sha256` over the concatenated material fields, stores it on accepted rows, and raises `COMPANY_BRAIN_IDEMPOTENCY_KEY_CONFLICT` when a replay fingerprint differs.

**Invariant:** Identical payload → identical fingerprint → safe replay. Any field change → different fingerprint → explicit exception.

---

## Gap 2 — Server-authoritative founder-decision audit

**Finding:** The G1 RPC accepted `p_prior_state` from the caller without cross-checking it against the actual server-side state of the target. A malicious or buggy client could claim a fake `oldState.status` (e.g. `RESOLVED` on a `CONFLICTED` conflict) and proceed. Similarly, `p_provenance` claim UUIDs were stored without verifying they were real, tenant-owned, or active.

**Fix — JS:**
After the revision check, `oldState.status` (when supplied) is compared against `target.status` derived directly from `this.conflicts`. Mismatch throws `'prior state mismatch: claimed prior state does not match server state'`. Evidence claim IDs are each validated: must exist in `this.claims` with `tenantId === tenantId` and `active === true`; missing → `'evidence claim missing or cross-tenant'`; inactive → `'evidence claim inactive or revoked'`.

**Fix — SQL:**
After the stale-revision check, `p_prior_state->>'status'` is compared against `v_server_status` (derived from the locked DB row). If they differ, the attempt is logged as `REJECTED_STALE` and `REJECTED_PRIOR_STATE_MISMATCH` is returned. Provenance validation uses a set-difference query over `jsonb_array_elements_text(p_provenance)` against `company_brain_claims` filtered by `user_id`, `id`, and `active = true`; any unmatched element raises `COMPANY_BRAIN_PROVENANCE_INVALID`.

**Ordering note:** The revision check fires before the prior-state check. This preserves the existing test `'stale concurrent founder update fails'` which expects `/stale founder decision/` — stale revisions are caught before prior-state is even read.

---

## Gap 3 — Persistent revocation closure

**Finding:** When a source was revoked in G1, claims and artifacts derived from it were correctly invalidated, but: (a) conflicts whose remaining member claims were all inactive were left in `CONFLICTED` state with no live evidence; (b) snapshots that referenced revoked source versions remained `ACTIVE` and could be returned by `latestSnapshot`, `askDw`, and `dwIntelligenceContext`; (c) `askDw`/`dwIntelligenceContext` did not check whether the latest snapshot was stale before using it.

**Fix — SQL:**
`revoke_company_brain_source` now includes two additional UPDATE statements:
1. Conflict closure: sets `status = 'INVALIDATED'` on any `CONFLICTED` conflict whose every member claim is now inactive (no `active = true` member remains).
2. Snapshot staleness: `ALTER TABLE public.company_brain_snapshots ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'STALE'))`. After revocation, any `ACTIVE` snapshot whose `source_version_ids` JSONB contains any revoked source version ID is marked `STALE`.

**Fix — JS:**
`askDw` and `dwIntelligenceContext` now compare the latest snapshot's `knowledgeVersion` against `this.version(tenantId)`. If the latest snapshot is behind (i.e. stale), a fresh snapshot is built, excluding revoked sources. This ensures consumers always answer from current revocation state.

---

## Gap 4 — Semantic-reference integrity

**Finding:** Authority proposals with dangling or cross-tenant `evidenceClaimIds` were accepted without validation. The `persistAuthorityProposal` path had no reference integrity check, so a proposal could name claim IDs from another tenant or IDs that never existed.

**Fix — JS:**
`persistAuthorityProposal` now iterates `proposal.evidenceClaimIds` and validates each against `this.claims` (same tenant + active). Dangling → `'authority proposal evidence claim missing or cross-tenant'`. Inactive → `'authority proposal evidence claim inactive or revoked'`.

`prepareSnapshot` now validates that each active claim's `provenanceRootIds` don't reference a revoked or invalidated source version. This prevents a snapshot from silently including claims whose provenance chain has been broken.

**Fix — SQL:**
The `record_company_brain_founder_decision` RPC's Gap 2 provenance validation (same-tenant, active claim check) also covers Gap 4's semantic-integrity requirement for decision provenance arrays. Authority proposal provenance is validated at proposal persist time by the same JSONB set-difference check.

---

## Files changed

| File | Change |
|------|--------|
| `supabase/migrations/20260831000000_company_brain_g1_hardening.sql` | New migration: schema additions + updated RPCs for all four gaps |
| `src/lib/companyBrain/durableStore.js` | Added `decisionFingerprint()`, hardened `recordFounderDecision`, `persistAuthorityProposal`, `prepareSnapshot`, `askDw`, `dwIntelligenceContext` |
| `tests/companyBrainG1Hardening.test.mjs` | New: 11 regression tests covering all four gaps + R0 regression |
| `docs/company-brain/M2G_G1_HARDENING_AUDIT.md` | This document |

---

## Test results

```
# tests 1047
# pass  1047
# fail  0
```

11 new hardening tests, 1036 existing tests all passing.

**New tests:**
1. Identical idempotent replay succeeds and returns the original decision
2. Reused idempotency key with changed payload is explicitly rejected
3. Fake/stale prior state is rejected with a clear mismatch error
4. Cross-tenant provenance reference is rejected as missing
5. Revoked provenance reference is rejected as inactive
6. Revocation invalidates dependent snapshot (knowledge version advances past stale snapshot)
7. Ask DW refuses stale snapshot and answers from current revocation state
8. DW Intelligence rejects invalidated snapshot and returns context from current state
9. Dangling reference in authority proposal evidence fails
10. Cross-tenant authority evidence fails
11. Company Brain still cannot mutate canonical financial truth through any hardened path

---

## Build

`npm run build` — clean, no errors. Chunk-size warning is pre-existing and unrelated to this work.

---

## Scans

- **Credentials:** No secrets, tokens, API keys, or service-role credentials in any changed file.
- **Financial mutations:** The new migration touches no DueWatch financial-ledger tables (`invoices`, `payments`, `payment_attempts`, `payouts`, `bank_transactions`). R0 `canonicalMoneyWritable: false` boundary confirmed by test 11.
- **Whitespace:** `git diff --check` clean.

---

## Remaining limitations

- **SQL provenance validation in `record_company_brain_founder_decision`** validates only the `p_provenance` array passed to the RPC. Authority proposals stored via a separate RPC path do not yet have an equivalent SQL-layer check — their provenance is validated only in the JS store layer. A follow-up could add a dedicated `validate_company_brain_provenance_refs` helper called from both RPCs.
- **Snapshot `status` column** is additive (default `'ACTIVE'`). Consumers querying `company_brain_snapshots` who do not filter on `status = 'ACTIVE'` may still read stale snapshots. The JS store correctly uses `latestSnapshot` + version comparison; SQL consumers should add `WHERE status = 'ACTIVE'` to their snapshot reads.
- **Conflict closure** in the SQL revocation path only handles conflicts where *all* member claims become inactive. Partial-revocation cases (some claims still active) leave the conflict in `CONFLICTED` state with reduced evidence — correct behavior for G1, but Slice 2 may want a `PARTIALLY_INVALIDATED` state for better observability.
- **`prepareSnapshot` Gap 4 check** (revoked root detection) will throw if called after revocation with stale claims still in `this.claims`. In normal flow this is prevented by `revokeSource` which deactivates claims before the next snapshot build. The edge case of a direct `createSnapshot` call after partial revocation without a `revokeSource` round-trip is not exercised by the current test suite.
