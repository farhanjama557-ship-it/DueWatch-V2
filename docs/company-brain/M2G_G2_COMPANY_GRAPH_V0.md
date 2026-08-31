# M2G-G2 Company Graph V0

## Mission boundary

Company Graph V0 organizes durable Company Brain knowledge by entity, relationship, semantic scope, and provenance. It does not decide legal applicability, policy precedence, canonical financial truth, or DW authority.

## Typed model

Node types cover company, client, person, role, contract, policy candidate, workflow, client exception, precedent, source, artifact, claim, and conflict.

Relationship types cover company/client membership, contracts, company/client applicability, person roles, company roles, observed delegation, workflow policy references, client exceptions, support/derivation, conflicts, precedents, historical context, aliases, and explicitly evidenced supersession.

Every operational node and edge carries:

- tenant;
- exact claim IDs and root source-version IDs;
- semantic scope;
- resolution state;
- explicit/derived and independent-evidence state;
- active/revoked state;
- effective-time metadata where supplied;
- confidence and uncertainty;
- graph schema/version compatibility;
- hard `canonicalFinancialTruth: false` and `dwAuthority: false` boundaries.

## Deterministic builder

The builder consumes the active G1 source-version and claim set, creates entity candidates, resolves identities, assigns scope, creates typed nodes/edges, attaches provenance, preserves ambiguity/conflicts, and produces a fingerprinted graph snapshot.

The same Brain knowledge version and source-version set returns the same graph version. A source-version or knowledge-version change produces a distinguishable graph version. Historical snapshots remain inspectable.

Consumers compare `brainKnowledgeVersion` with the current Company Brain knowledge version before returning a graph. Ask DW and DW Intelligence deterministically rebuild when the graph is stale; they never silently reuse the older snapshot.

Stable-key deduplication unions every normalized claim/root pair. Multiple independent roots remain visible and countable. If independent claims assign materially different identity attributes to one stable entity identifier, the node retains all variants and becomes `CONFLICTED` rather than silently choosing the first value.

Revocation removes dependent nodes and edges from the next active snapshot. The SQL persistence trigger also marks root-dependent persisted graph rows and their active graph version invalid when a G1 source version becomes revoked. Unrelated graph structure remains available in the rebuilt graph.

Normalized provenance rows are authoritative in persistence. Deferred constraint triggers require the JSON retrieval projection, primary claim/root pair, and normalized tenant-composite rows to agree in both directions. Revocation checks both the normalized rows and the validated root projection, including non-primary roots.

## Retrieval

Typed retrieval supports entity lookup, alias resolution, client contracts, scoped policies, unresolved relationships, role/delegation context, client precedents, provenance lookup, active graph version, graph-grounded Ask DW responses, and typed DW Intelligence graph context.

All retrieval is tenant-bound and uses the active graph snapshot. Revoked or historical-only aliases do not become current operational matches.
