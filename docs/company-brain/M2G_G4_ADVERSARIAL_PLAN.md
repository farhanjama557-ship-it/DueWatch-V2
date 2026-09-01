# M2G-G4 Adversarial Plan

## Test target

`tests/companyBrainG4OperatingModel.test.mjs` exercises the real G1 durable store, G2 graph store, G3 policy resolver, controlled Company Brain fixtures, the G4 reasoning layer, replay store, and G4 SQL migration.

## Scenarios

1. Same tenant evidence and G3 state produce the same semantic fingerprint despite different generation timestamps.
2. Every confirmed statement has claim, graph-node, and root-source provenance.
3. An unresolved G3 company late-fee conflict remains conflicted with null value in G4.
4. Unequal confidence never selects a policy winner.
5. Atlas-specific terms remain in Atlas client overrides and never widen to company policy.
6. “Give Atlas 20% off” remains observed communication and never becomes settlement policy.
7. Founder/controller/account-manager participation remains observed human responsibility and grants no DW authority.
8. Historical 10% evidence and precedents remain historical-only.
9. Source revocation makes the prior proposal stale before graph rebuild.
10. Regeneration after revocation removes affected evidence and changes the fingerprint deterministically.
11. An explicit G3 founder decision changes the upstream policy state and proposal fingerprint without creating execution authority.
12. Tenant A cannot read or incorporate Tenant B sources, claims, graph objects, conflicts, roles, clients, or proposals.
13. The same proposal fingerprint persists idempotently.
14. Changed upstream state creates a new revision and supersedes the prior proposal.
15. Runtime and migration contain no canonical financial-table mutation.
16. No email, reminder scheduling, fee, waiver, write-off, settlement, or collection-action executor exists.
17. Missing promises-to-pay evidence produces an unresolved founder question rather than a guessed workflow.
18. Canonical money, authority, automation, and approval boundaries are all false.
19. A mutated self-approved payload is rejected by persistence validation.
20. Evidence and provenance survive persistence round trip; review context has no approval capability.
21. The migration parses with the repository's real PostgreSQL parser and a corrupted variant fails.
22. SQL structurally enforces tenant RLS, read-only browser grants, exact normalized claim-root provenance, and automatic proposal staleness.
23. Ambiguous and unresolved G2 entity identities become explicit founder questions rather than guessed links.
24. A proposal made stale by revocation cannot be persisted or idempotently replayed as current; an existing current replay row becomes explicitly stale.
25. Review context reports stale material as `STALE` and `reviewBlocked`, never as apparently current founder-review material.
26. Future descriptive evidence is non-current, expired/historical evidence stays non-current, and current evidence remains usable with exact effective-time metadata.
27. Entity, alias, orphan-reference, and unsupported metadata do not fall through into collections statements.
28. Top-level and nested client-override semantic tampering fail canonical fingerprint/integrity validation.
29. Parser-backed SQL assertions prove current rows require active exact Brain/graph lineage, knowledge version, and graph fingerprint binding.
30. A proposal built for one as-of date cannot masquerade as current for another date without regeneration.

## Controlled Acme/Atlas proof

- Company workflow: reminder cadence is extracted from actual fixture evidence rather than hardcoded in G4.
- Company policy conflict: the 5% policy and founder stop instruction remain unresolved through G3 and G4.
- Atlas: 2% evidence remains client-scoped; no company widening occurs.
- Founder instruction: it remains explicit conflict evidence and cannot be hidden by an operating summary.
- Account-manager communication: 20% discount language remains observation only.
- Roles: founder, controller/accounting, and account-manager participation remains human context, not DW authority.
- History: old 10% policy and precedents remain historical-only.
- Revocation: the old proposal becomes stale and regeneration removes the affected statement.
- Policy decision: a G3 decision changes the model fingerprint/state but does not approve the operating model.
- Tenant isolation: every evidence and persistence read is exact-tenant.

## Exit expectations

All G0-G3 tests remain unchanged and passing. G4 must fail closed when policy, temporal state, identity, provenance, or evidence is insufficient. No test may obtain a cleaner model by bypassing G3.
