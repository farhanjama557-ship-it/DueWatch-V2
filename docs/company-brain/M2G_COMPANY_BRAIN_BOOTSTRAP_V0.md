# M2G Company Brain Bootstrap V0

Status: M2G-G0 controlled proof only
Canonical financial doctrine: R0 Final Freeze, immutable

## Contract

Company Brain is a tenant-scoped knowledge and decision context. It may explain policy, contracts, roles, delegation, preferences, history, and precedent. It is not an invoice, payment, settlement, payout, or bank ledger.

The implementation in `src/lib/companyBrain/` is deliberately local and deterministic. It has no Supabase client, provider client, execution transport, UI, or canonical financial mutation surface.

## R0 boundaries preserved

- The six R0 truth dimensions remain owned by their configured canonical sources.
- `createClaim` rejects R0 money-truth claim types and claims marked as canonical financial truth.
- `assertCompanyBrainCannotWriteCanonicalMoney` is the explicit integration guard.
- The contextual statement “Invoice 104 was paid yesterday” remains an `INTERPRETATION` and routes Ask DW to `R0_AUTHORITATIVE_FINANCIAL_READ`.
- Company Brain policy/context cannot overwrite current invoice/payment truth.
- Unknown provenance fails closed.

These boundaries implement R0-I01, R0-I02, R0-I03, R0-I05, R0-I06, R0-I11, R0-I12, R0-I14, the R0 Claim Ownership Matrix, and the R0 Evidence & Provenance Contract without amending them.

## Domain objects

| Object | G0 representation |
|---|---|
| Source | Tenant, type, trust zone, timestamp/version, ingestion time, hash, active/revoked state. |
| Artifact | Classified parsed unit with a source and root-source lineage. |
| Claim | Typed assertion with semantic/subject scope, value, explicit/derived flag, confidence/uncertainty, status, assumptions, artifact lineage, and roots. |
| Conflict | All incompatible claims, scopes, and values; no confidence winner. |
| Operating rule candidate | Structured `proposed` item in the operating model; not approved policy. |
| Role/delegation candidate | Typed `ROLE` / `DELEGATION` claims; observed delegation is not execution authority. |
| Authority proposal | `PROPOSED`, changed only by authenticated founder decision to `APPROVED`, `REJECTED`, or `REVOKED`. |
| Founder decision | Tenant/actor/time/type/target/old/new/evidence/reason/revocability record. |
| Brain snapshot | Deterministic active graph fingerprint plus conflicts, decisions, policies, authority, invalidations, and tombstones. |
| Tombstone | Durable root-source revocation that excludes dependent artifacts and claims while preserving audit history. |

The claim vocabulary contains all G0 classes: `COMPANY_POLICY`, `CLIENT_EXCEPTION`, `ROLE`, `DELEGATION`, `AUTHORITY`, `COMMUNICATION_PREFERENCE`, `COLLECTION_WORKFLOW`, `DISPUTE_PROCESS`, `PAYMENT_TERMS_CONTEXT`, `HISTORICAL_PRECEDENT`, `FOUNDER_INSTRUCTION`, and `INTERPRETATION`.

## Deterministic fixture pipeline

`fixtureIngestion.js` reads the closed eight-file Acme fixture pack, checks fixture markers, hashes each root, classifies each artifact, and emits 15 typed claims. There is no model call.

The initial snapshot detects one late-fee conflict containing:

- current company SOP: 5%;
- Atlas contract exception: 2% when applicable;
- historical spreadsheet: 10%;
- founder instruction: disabled until a new policy is approved.

It preserves the company, client, historical, and founder scopes. Before a founder decision, the conflict is `CONFLICTED`, approved policy is empty, and DW authority is `REQUIRE_APPROVAL`.

## Operating model and founder loop

`buildOperatingModel` returns distinct `observed`, `inferred`, `conflicted`, `missing`, `proposed`, and `approved` collections. Evidence claim IDs remain attached to proposals.

The controlled founder decision resolves only the named late-fee scope:

- globally disabled;
- Atlas 2% exception retained only when applicable;
- no automatic add/waive authority.

The original conflict and competing claims remain inspectable after resolution. No claim is silently rewritten or discarded.

## Authority anti-escalation

`evaluateCompanyBrainAuthority` reads only explicit approved proposals. Twenty repeated approvals produce a suggestion to consider standing policy; the 21st case still returns `REQUIRE_APPROVAL`. An explicit grant applies only to its exact action class and scope. Revocation removes it from the active snapshot immediately.

## Revocation behavior

Revoking a root Source creates a tombstone and removes dependent Artifacts and Claims from the active snapshot. Invalidated claims remain auditable. A derived/model summary retains the revoked root, is marked as non-independent corroboration, and cannot resurrect the claim.

## Ask DW seam

`answerAskDwFromCompanyBrain` proves four bounded questions:

1. Late-fee policy is reported as conflicted before resolution and evidence is listed.
2. Atlas 20% waiver is approval-required because an account-manager statement grants no authority.
3. Invoice 104 payment truth is routed to the R0 authoritative financial read.
4. Atlas terms cite the client-contract provenance.

This is a domain seam, not a UI redesign or a new chat runtime.

## DW Intelligence seam

`toDwIntelligenceCompanyContext` emits `DW_INTELLIGENCE_COMPANY_CONTEXT_V0`, a closed typed object containing applicable approved policy, unresolved conflicts, roles, delegation, explicit authority state, precedent, claim-to-root provenance, and revocation state. Its boundary flags make canonical money read-only and prevent context from granting authority.

## Deferred work

G0 does not select a production database schema, ingest external systems, authenticate a live founder-decision UI, execute external actions, or implement the final Company Brain experience. Those decisions wait for M2G-G1 or M2H as listed in `M2G_G0_EVIDENCE.md`.
