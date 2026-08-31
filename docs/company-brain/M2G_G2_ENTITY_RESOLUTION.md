# M2G-G2 Entity Resolution

## Resolution order

1. Filter candidates by authenticated tenant and requested entity type.
2. Prefer one exact stable identifier.
3. Otherwise compare normalized names and currently supported aliases.
4. Return `RESOLVED` only for exactly one deterministic candidate.
5. Return `AMBIGUOUS` for multiple candidates, `UNRESOLVED` for none, and `CONFLICTED` when exact identity and supplied reference contradict one another.

Normalization performs Unicode normalization, lowercasing, and punctuation/space removal. It is candidate discovery, not evidence. It cannot merge records by itself.

## Controlled cases

- `Atlas Co` resolves to stable client `atlas` because the tenant registry explicitly supplies that alias.
- Two same-tenant clients, `acme-us` and `acme-eu`, normalize to the same client name and share `Acme`; `Acme` therefore remains ambiguous.
- The Acme US contract resolves because it includes stable identifier `acme-us`, despite its shortened ambiguous display reference.
- A person named Acme never collides with client candidates because entity type is part of resolution.
- Cross-tenant Atlas records never merge or appear in another tenant's candidate set.
- `Old Atlas` is a historical alias with an end date and is non-operational for current lookup.
- `Northwind West` has no registry evidence and remains unresolved.

`ALIAS_OF` is emitted only when an alias record contains an exact supported target. Historical alias edges remain inactive. No operational action may select an ambiguous or unresolved candidate.

When separate roots use the same stable ID with materially conflicting normalized name or company membership, resolution becomes `CONFLICTED`. All identity variants and provenance roots remain inspectable; exact-ID matching does not override that conflict.
