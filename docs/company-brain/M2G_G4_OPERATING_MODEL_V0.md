# M2G-G4 Company Operating Model V0

## Mission

G4 produces a deterministic, provenance-backed proposal describing how a tenant appears to run accounts receivable. It consumes the frozen G2 Company Graph and G3 policy-resolution APIs. It does not approve the proposal, grant DW authority, execute AR work, or write canonical financial truth.

The public runtime is `src/lib/companyBrain/operatingModel.js`.

## Public APIs

- `buildOperatingModelProposal({ actor, tenantId, brain, graph, queryDate, generatedAt })`
- `isOperatingModelStale({ proposal, actor, tenantId, brain, graph, asOfDate })`
- `OperatingModelProposalStore`
- `persistOperatingModelProposal(store, { actor, tenantId, proposal, brain, graph, asOfDate })`
- `getOperatingModelProposal(store, { actor, tenantId, proposalId, brain, graph, asOfDate })`
- `toOperatingModelReviewContext(proposal, { actor, tenantId, brain, graph, asOfDate })`

Reasoning is independently testable and does not require persistence.

## Proposal contract

`COMPANY_OPERATING_MODEL_PROPOSAL_V0` contains:

- stable `proposalId`, `revision`, semantic `fingerprint`, and explicit `asOfDate`;
- exact upstream `knowledgeVersion`, graph version/fingerprint, and G3-relevant source fingerprint;
- company, collections, billing, reminders, promises-to-pay, escalation, disputes, client handling, roles/responsibilities, communication, and policy-operating sections;
- exact client overrides that never widen to company scope;
- deterministic unresolved questions and blockers;
- an evidence index plus aggregate claim, graph-node, and root-source provenance;
- immutable safety boundaries.

Generation time is metadata and is excluded from semantic identity.

## Statement semantics

Every `OPERATING_MODEL_STATEMENT_V0` is independently inspectable and carries scope, evidence claims, graph nodes, root source versions, conflict keys, derivation/explicitness, `effectiveTime`, `temporalState`, `currentApplicable`, and explanation. G4 reuses G3's frozen temporal classifier. Missing dates remain `UNKNOWN`; they are never silently interpreted as current.

- `CONFIRMED`: current explicit operating evidence or an applicable G3-resolved rule supports the statement.
- `OBSERVED`: communication, role, responsibility, or behavior evidence is useful context but is not policy or authority.
- `PROPOSED`: reserved for explicitly labeled interpretations; it never becomes binding merely by generation.
- `UNRESOLVED`: evidence, identity, or temporal applicability is insufficient, or G3 abstains.
- `CONFLICTED`: G3 reports unresolved policy conflict. Value remains null and founder review is required.
- `HISTORICAL_ONLY`: retained for context and never promoted to a current rule.

Confidence remains informational and never changes state or precedence.

## G3 handoff

Policy-backed statements call `resolvePolicy()` for each exact topic and scope. G4 does not classify or resolve policy conflicts itself.

- G3 `CONFLICTED` becomes G4 `CONFLICTED` with null value and exact conflict keys.
- G3 `ABSTAIN`, or unresolved temporal applicability, becomes G4 `UNRESOLVED`.
- G3 `RESOLVED` may become `CONFIRMED` when temporal applicability is also established.
- G3 client candidates remain within `clientOverrides`; no client evidence widens to company scope.

## Operating evidence

Current explicit workflow, cadence, dispute, contract, and payment-terms claims can describe confirmed operating practice with exact provenance. Future and unknown-time descriptive evidence is non-current and unresolved; expired or historical evidence is `HISTORICAL_ONLY`. Role and delegation claims remain `OBSERVED`; every role output preserves `observedDelegationIsAuthority:false` and `dwAuthorityDerived:false`. Communication and contextual financial statements remain observations, not policy or canonical money truth.

Only explicitly mapped operating evidence types enter operating sections. Entity, alias, orphan-reference, and unsupported metadata never fall through into collections; G2 identity-resolution findings remain available as deterministic unresolved questions.

Missing areas, such as promises-to-pay evidence, generate deterministic founder-review questions rather than guessed values.

## Freshness and determinism

The proposal is bound to tenant, Company Brain knowledge version, graph version/fingerprint, source-version set, founder decisions, scoped G3 results, and as-of date. The pure builder does not claim a durable Brain snapshot ID: frozen G1 `prepareSnapshot()` does not expose one, and G4 does not mutate G1 merely to manufacture it. Durable persistence uses the actual G2 runtime 64-character graph fingerprint with tenant ID to resolve the exact persisted G2 graph row, then derives the exact Brain snapshot through that row. The runtime `graphVersion` string remains debug metadata and is never represented as the persisted graph UUID.

All currentness operations—freshness evaluation, persistence, review, and normal get/replay—require current Brain/graph context plus an explicit canonical `asOfDate`. None defaults to the proposal's old date. A stale proposal cannot be inserted or replayed as current; a formerly-current replay row is marked `STALE` with `invalidatedAt`. Review context always exposes `stale` and `reviewBlocked`, and cannot present stale material as a current `PROPOSED`/`BLOCKED` review. Superseded history is not rewritten.

Building after revocation or another knowledge mutation deterministically rebuilds the graph and produces a different proposal fingerprint. Identical active evidence, graph state, and G3 state reproduce the same proposal identity.

## Persistence

The runtime proposal store proves replay, idempotency, supersession, stale replay invalidation, tenant isolation, semantic-integrity checks, and provenance round trips without coupling reasoning tests to a database. Validation recomputes the canonical semantic fingerprint and proposal ID, binds revision to source state, recursively validates client-override statements, and requires exact evidence-index provenance for every current confirmed statement.

Migration `20260901034230_company_operating_model_g4.sql` adds the smallest durable database projection:

- `company_operating_model_proposals` binds each proposal to one exact graph row through the composite foreign key `(user_id, graph_fingerprint) → company_graph_versions(user_id, fingerprint)`; it does not coerce the runtime graph-version string into a UUID or redundantly accept a caller-supplied Brain snapshot ID;
- `company_operating_model_proposal_evidence` normalizes every claim/source-version pair and references the exact tenant-composite `company_brain_claim_roots` key;
- deferred validators require the JSON evidence projection and normalized provenance to agree in both directions;
- an insert/update validator loads that tenant graph row, follows its `brain_snapshot_id` to the exact tenant Brain snapshot, and binds knowledge version, graph fingerprint, JSON source state, and active status for current rows;
- graph invalidation marks directly referenced proposals stale; Brain snapshot invalidation marks proposals stale by joining through `company_graph_versions.brain_snapshot_id`;
- RLS and grants expose authenticated tenant-bound reads only;
- database checks permanently require all money, authority, automation, and approval boundaries to remain false.

The migration is repository-validated only. It has not been applied to or runtime-verified in an isolated Supabase/Postgres environment, and it has not been deployed.

## Phase boundaries

G4 creates review material only. G5 owns authority/delegation. G6 owns founder review/approval experience. G7 owns full conversational integration. G8 owns the final system gate. M2H owns live provider integrations. None are implemented here.
