# M2G-G2 Semantic Scope Model

Scope is independent of confidence, repetition, graph position, and authority.

| Scope | Meaning |
| --- | --- |
| `INTERACTION` | One communication or interaction; cannot widen from speaker confidence. |
| `DOCUMENT` | Evidence applies only to the identified document/reference until resolved. |
| `CLIENT` | Applies only to one deterministically resolved client. |
| `ROLE` | Describes a person/role relationship or observed responsibility. |
| `WORKFLOW` | Describes workflow structure or a policy reference, not policy approval. |
| `COMPANY` | Explicit company-level candidate; not automatically an approved policy. |
| `HISTORICAL` | Historical context; not current solely because it is linked in the graph. |

## Locked behavior

- Atlas contract and exception records remain Atlas-scoped.
- Collections SOP evidence remains company-scoped but can remain conflicted.
- The 2022 10% policy stays historical and links with `HISTORICAL_TO`, never `APPLIES_TO_COMPANY`.
- Founder instruction scope remains exactly what its durable claim states.
- Account-manager material remains interaction/client context and cannot create settlement authority.
- Repeated client-local documents do not create a company-level applicability edge.
- Workflow references organize candidates but do not resolve which policy wins.
- Observed delegation is explicitly not DW authority.

G3 owns richer precedence and temporal applicability. G2 does not infer them.
