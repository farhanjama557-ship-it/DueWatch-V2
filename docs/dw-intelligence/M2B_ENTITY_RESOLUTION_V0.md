# Ask DW M2B — Real Client / Invoice Resolution v0

Status: implementation candidate for M2B.

## Goal

Replace pre-seeded conversational entity references with a real authenticated,
tenant-scoped, deterministic resolver for client names and invoice numbers.

M2B resolves **references only**. It does not become a second financial truth
engine and it does not grant business authority.

## Runtime

Founder turn
→ M1D reference-only case state
→ M2B authenticated entity resolver
→ safe M1E resolver events only
→ resolved client/invoice references
→ existing M1E deterministic conversation controls
→ M2A fresh controlled activation read
→ DW Intelligence truth / fail-closed authority
→ answer

## Resolver reads

Clients:

`id,user_id,name,created_at`

Invoices:

`id,user_id,client_id,inv_num,created_at`

The resolver deliberately does **not** select amount, amount paid, balance,
currency, due date, payment state, activity, policy or authority fields.
Those remain owned by the fresh M2A/DW Intelligence read after reference
resolution.

## M2B invariants

1. Authentication is verified before resolver table reads.
2. Every client/invoice read is explicitly tenant-scoped.
3. Cross-tenant resolution fails before table reads when auth does not match.
4. Resolver performs no insert/update/upsert/delete/RPC/client creation.
5. Existing `normalizeClientText` is reused for deterministic client text normalization.
6. Full-name matches outrank partial-name/token matches.
7. Multiple equally strong client matches fail closed.
8. A cued unknown client (for example `What about Bob?`) fails closed instead of silently reusing the old client.
9. Explicit invoice numbers are resolved tenant-wide using exact case-insensitive number variants.
10. Duplicate invoice-number matches fail closed.
11. Invoice owner client is re-read and tenant-verified.
12. Client invoice candidate references are bounded to the M1D case-state limit.
13. A client with multiple resolved invoices is not silently assigned one when no invoice is already active.
14. A client with one invoice may select that sole invoice deterministically.
15. An already-active invoice is preserved when the same client is re-mentioned and that invoice remains in the resolved candidate set.
16. `the other invoice` remains M1E deterministic control and only switches when there is exactly one resolved alternate.
17. Resolver output can return a blocked reference-resolution status, but cannot emit action-control events.
18. Exact deterministic founder-control phrases keep precedence over a resolver block.
19. Case state stores references only; no financial truth or authority is persisted by M2B.
20. Provider/model calls are not required for identity resolution.
21. No client-level financial aggregation or mental summing is introduced.
22. Missing/ambiguous resolution stays explicit; the resolver never guesses.
23. Resolver outcome statuses are allowlisted; untrusted resolver output cannot invent execution-like conversation states.
24. A broad client token exceeding the bounded query window cannot force a wrong partial match; a stronger multi-token/full-name match may proceed only when deterministically supported.
25. When a client exceeds the invoice-candidate bound, an existing active invoice must be re-read by exact tenant-scoped ID and ownership-verified before it can be preserved.
26. Incomplete client invoice sets never power `the other invoice`; the candidate set is reduced to the verified active invoice or cleared.

## Safe events

M2B may emit only events already allowed by M1E's resolver gate, principally:

- `SET_ACTIVE_CLIENT`
- `SET_INVOICE_CANDIDATES`
- `SELECT_INVOICE`
- `RESOLVE_REFERENCE`

It does not gain access to:

- `OFFER_ACTION`
- `REQUEST_ACTION_CONFIRMATION`
- `SUSPEND_ACTION`
- `CONFIRM_ACTION_REFERENCE`
- execution
- canonical mutation

## Resolution behavior

### Unique client + one invoice

`What's going on with Anthony?`

→ authenticated client match
→ client reference
→ sole invoice candidate
→ selected invoice reference
→ existing M2A fresh truth read
→ answer

### Unique client + multiple invoices

`What's going on with Anthony?`

→ authenticated client match
→ client reference
→ invoice reference candidates
→ `NEEDS_INVOICE_RESOLUTION`
→ no financial live read until an invoice is explicit

This is intentionally fail-closed. Client-level portfolio intelligence belongs to
a later capability and must not be faked by summing invoice-scoped results.

### Ambiguous client

If two tenant clients are equally strong matches for `Anthony`:

→ `NEEDS_CLIENT_RESOLUTION`
→ no invoice read
→ no live financial read
→ explicit selection required

### Exact full name

If `Anthony Miller` and `Anthony Davis` exist, the full phrase `Anthony Miller`
resolves the exact full-name match rather than treating the shared first name as
enough to create ambiguity.

### Explicit invoice number

`Check INV-1902`

→ exact tenant invoice-number lookup
→ verified owner client
→ candidate references for that client when safely bounded
→ selected exact invoice
→ M2A fresh live read

### Unknown referenced client

If Anthony is currently active and the founder asks `What about Bob?`, but Bob
cannot be verified:

→ `CLIENT_NOT_FOUND`
→ Anthony remains in case state
→ no live read is performed against Anthony for the Bob question

## Bounded candidate behavior

M1D supports at most 20 invoice candidate references in one case. M2B honors
that boundary.

When an exact invoice number is resolved for a client with more than 20 invoices,
the exact invoice may still be selected, but M2B does not pretend it has a
complete `other invoice` candidate set.

When only a client is resolved and the client exceeds the safe candidate bound,
M2B requires an explicit invoice number.

## Deferred

### M2C
Durable server persistence for conversation/case state.

### M2D
Hosted payment ledger, reconciliation, execution history and DW evidence/schema catch-up.

### M2E
Founder-facing Ask DW entity selection/citations/Evidence Brief UI.

### M2F
Production golden scenario using real hosted resolution + grounded conversation.

## Acceptance gate

M2B is not complete until all of the following pass on the actual DueWatch repo:

1. M2B focused entity resolver tests.
2. M2A + M1D/M1E conversation regression tests.
3. Full DueWatch test suite.
4. Production Vite build.
5. `git diff --check`.
6. Final diff review proving only read-only resolver/reference behavior was added.
7. Commit/push/PR and merge verification on `main`.

Until those gates pass, M2B remains an implementation candidate, not complete.
